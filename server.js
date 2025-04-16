const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_key_12345_secure_random_string';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/sol_basket';

// Visit Counter
let visitCount = 0;

// Middleware
app.use(express.json());
app.use(cors({
  origin: ['https://sol-client.vercel.app', 'http://localhost:3000', 'http://localhost:3001', process.env.CLIENT_URL],
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

// Vote Schema
const voteSchema = new mongoose.Schema({
  support: { type: Number, default: 0 },
  oppose: { type: Number, default: 0 },
  voters: [{ type: String }],
  visitors: [{ ip: String, timestamp: Number }],
  visitCount: { type: Number, default: 0 },
});

const Vote = mongoose.model('Vote', voteSchema);

// Read persistent data
const readVotes = async () => {
  try {
    let voteDoc = await Vote.findOne();
    if (!voteDoc) {
      voteDoc = new Vote();
      await voteDoc.save();
    }
    return {
      support: voteDoc.support,
      oppose: voteDoc.oppose,
      voters: new Set(voteDoc.voters),
      visitors: voteDoc.visitors,
      visitCount: voteDoc.visitCount,
    };
  } catch (err) {
    console.error('Error reading votes:', err);
    return {
      support: 0,
      oppose: 0,
      voters: new Set(),
      visitors: [],
      visitCount: 0,
    };
  }
};

// Save persistent data
const saveVotes = async (votes, voters, visitors, visitCount) => {
  try {
    await Vote.updateOne(
      {},
      {
        support: votes.support,
        oppose: votes.oppose,
        voters: Array.from(voters),
        visitors,
        visitCount,
      },
      { upsert: true }
    );
  } catch (err) {
    console.error('Error saving votes:', err);
  }
};

// Initialize data
let votes, allVoters, allVisitors;
readVotes().then(data => {
  votes = { support: data.support, oppose: data.oppose };
  allVoters = data.voters;
  allVisitors = data.visitors;
  visitCount = data.visitCount;
});

// Visit Counter Middleware
app.use(async (req, res, next) => {
  try {
    visitCount++;
    await Vote.updateOne({}, { visitCount }, { upsert: true });
    console.log(`Посещений: ${visitCount}`);
    next();
  } catch (err) {
    console.error('Error updating visit count:', err);
    next();
  }
});

// Clean expired visitors
const cleanVisitors = () => {
  const now = Date.now();
  const expiry = 5 * 60 * 1000; // 5 minutes
  allVisitors = allVisitors.filter(v => now - v.timestamp < expiry);
  saveVotes(votes, allVoters, allVisitors, visitCount);
};

// Clean every minute
setInterval(cleanVisitors, 60 * 1000);

// Root Endpoint for Visit Count
app.get('/', (req, res) => {
  res.send(`Количество посещений: ${visitCount}`);
});

// Vote endpoints
app.post('/vote', async (req, res) => {
  const { vote } = req.body;
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

  if (allVoters.has(ip)) {
    return res.status(403).json({ message: 'You already voted.' });
  }

  if (vote === 'support' || vote === 'oppose') {
    votes[vote]++;
    allVoters.add(ip);
    await saveVotes(votes, allVoters, allVisitors, visitCount);
    return res.json({ success: true });
  }

  return res.status(400).json({ message: 'Invalid vote.' });
});

app.get('/results', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  const now = Date.now();
  if (!allVisitors.find(v => v.ip === ip)) {
    allVisitors.push({ ip, timestamp: now });
    await saveVotes(votes, allVoters, allVisitors, visitCount);
  }

  cleanVisitors();
  res.json({
    votes,
    visitors: allVisitors.length,
    message: 'Thank you for your visit!',
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

// Track Visitor Route
app.post('/api/visitors/track', async (req, res) => {
  try {
    const { userAgent } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const now = Date.now();

    // MongoDB tracking
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

    // File-based tracking (now in MongoDB)
    if (!allVisitors.find(v => v.ip === ip)) {
      allVisitors.push({ ip, timestamp: now });
      await saveVotes(votes, allVoters, allVisitors, visitCount);
    }

    cleanVisitors();
    const visitorCount = await Visitor.countDocuments();
    const userCount = await User.countDocuments();

    res.json({
      users: userCount,
      visitors: visitorCount,
      realtimeVisitors: allVisitors.length,
    });
  } catch (err) {
    console.error('Error tracking visitor:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get User and Visitor Counts Route
app.get('/api/users/count', async (req, res) => {
  try {
    const userCount = await User.countDocuments();
    const visitorCount = await Visitor.countDocuments();
    cleanVisitors();
    res.json({
      users: userCount,
      visitors: visitorCount,
      realtimeVisitors: allVisitors.length,
      totalVisits: visitCount,
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