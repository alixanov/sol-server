const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs');

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_key_12345_secure_random_string';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/sol_basket';
const DB_FILE = process.env.DB_FILE || 'votes.json';

// Middleware
app.use(express.json());
app.use(cors({
  origin: ['https://sol-client.vercel.app', process.env.CLIENT_URL || 'http://localhost:3001'],
  credentials: true,
}));

// MongoDB connection
mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// User Schema
const userSchema = new mongoose.Schema({
  firstName: { type: String, required: false },
  lastName: { type: String, required: false },
  login: { type: String, required: true, unique: true, trim: true },
  password: { type: String, required: true },
}, { timestamps: true });

const User = mongoose.model('User', userSchema);

// Visitor Schema
const visitorSchema = new mongoose.Schema({
  ip: { type: String, required: true },
  userAgent: { type: String },
  date: { type: Date, default: Date.now },
});

const Visitor = mongoose.model('Visitor', visitorSchema);

// Kalıcı veriyi oku (Read persistent data)
const readVotes = () => {
  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
    return {
      support: data.support || 0,
      oppose: data.oppose || 0,
      voters: new Set(data.voters || []),
      visitors: new Set(data.visitors || []),
    };
  } catch {
    return {
      support: 0,
      oppose: 0,
      voters: new Set(),
      visitors: new Set(),
    };
  }
};

// Kalıcı veriyi kaydet (Save persistent data)
const saveVotes = (votes, voters, visitors) => {
  const data = {
    support: votes.support,
    oppose: votes.oppose,
    voters: Array.from(voters),
    visitors: Array.from(visitors),
  };
  fs.writeFileSync(DB_FILE, JSON.stringify(data), "utf-8");
};

const stored = readVotes();
let votes = { support: stored.support, oppose: stored.oppose };
let allVoters = stored.voters;
let all_visitors = stored.visitors;

// Vote endpoints
app.post("/vote", (req, res) => {
  const { vote } = req.body;
  const ip = req.ip;

  if (allVoters.has(ip)) {
    return res.status(403).json({ message: "You already voted." });
  }

  if (vote === "support" || vote === "oppose") {
    votes[vote]++;
    allVoters.add(ip);
    saveVotes(votes, allVoters, all_visitors);
    return res.json({ success: true });
  }

  return res.status(400).json({ message: "Invalid vote." });
});

app.get("/results", (req, res) => {
  const ip = req.ip;
  if (!all_visitors.has(ip)) {
    all_visitors.add(ip);
    saveVotes(votes, allVoters, all_visitors);
  }

  res.json({
    votes: votes,
    visitors: all_visitors.size,
    message: "Thank you for your visit!",
  });
});

// Register Route
app.post('/register', async (req, res) => {
  try {
    const { firstName, lastName, login, password } = req.body;

    if (!login || !password) {
      return res.status(400).json({ error: 'Login and password are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    if (login.length < 3) {
      return res.status(400).json({ error: 'Login must be at least 3 characters' });
    }

    const existingUser = await User.findOne({ login });
    if (existingUser) {
      return res.status(400).json({ error: 'Login already exists' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const user = new User({
      firstName,
      lastName,
      login,
      password: hashedPassword,
    });
    await user.save();

    res.status(201).json({ message: 'User registered successfully' });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Login Route
app.post('/login', async (req, res) => {
  try {
    const { login, password } = req.body;

    if (!login || !password) {
      return res.status(400).json({ error: 'Login and password are required' });
    }

    const user = await User.findOne({ login });
    if (!user) {
      return res.status(401).json({ error: 'Invalid login or password' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid login or password' });
    }

    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '7d' });

    const userData = {
      id: user._id,
      firstName: user.firstName,
      lastName: user.lastName,
      login: user.login,
    };

    res.json({ token, user: userData });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Track Visitor Route (updated with both MongoDB and file-based tracking)
app.post('/api/visitors/track', async (req, res) => {
  try {
    const { userAgent } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

    // MongoDB tracking (for long-term analytics)
    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);

    const existingVisitor = await Visitor.findOne({
      ip,
      date: { $gte: oneDayAgo },
    });

    if (!existingVisitor) {
      const visitor = new Visitor({
        ip,
        userAgent,
      });
      await visitor.save();
    }

    // File-based tracking (for real-time counts)
    if (!all_visitors.has(ip)) {
      all_visitors.add(ip);
      saveVotes(votes, allVoters, all_visitors);
    }

    const visitorCount = await Visitor.countDocuments();
    const userCount = await User.countDocuments();

    res.json({
      users: userCount,
      visitors: visitorCount,
      realtimeVisitors: all_visitors.size, // Добавлено: текущее количество посетителей из файла
    });
  } catch (err) {
    console.error('Error tracking visitor:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get User and Visitor Counts Route (updated)
app.get('/api/users/count', async (req, res) => {
  try {
    const userCount = await User.countDocuments();
    const visitorCount = await Visitor.countDocuments();
    res.json({
      users: userCount,
      visitors: visitorCount,
      realtimeVisitors: all_visitors.size, // Добавлено: текущее количество посетителей из файла
    });
  } catch (err) {
    console.error('Error fetching counts:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Error Handling Middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.stack);
  res.status(500).json({ error: 'Something went wrong' });
});

// Start Server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});