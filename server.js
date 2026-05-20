require('dotenv').config();
const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-change-me';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@fibclanka.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'FIBCAdmin2024!';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';

// Ensure uploads directory exists
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

// Database
const db = new Database('fibc_ai.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    department TEXT NOT NULL,
    role TEXT DEFAULT 'user' CHECK(role IN ('user','manager','admin')),
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    department TEXT,
    data_type TEXT,
    original_name TEXT,
    row_count INTEGER DEFAULT 0,
    file_path TEXT,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS upload_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    upload_id INTEGER REFERENCES uploads(id),
    row_index INTEGER,
    json_data TEXT
  );

  CREATE TABLE IF NOT EXISTS insights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    upload_id INTEGER,
    insight_type TEXT,
    title TEXT,
    content TEXT,
    department TEXT,
    generated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    department TEXT,
    metric_name TEXT,
    target_value REAL,
    period TEXT
  );
`);

// Seed admin user
const seedAdmin = () => {
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(ADMIN_EMAIL);
  if (!existing) {
    const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
    db.prepare('INSERT INTO users (name, email, password, department, role) VALUES (?,?,?,?,?)')
      .run('System Admin', ADMIN_EMAIL, hash, 'Administration', 'admin');
    console.log('✅ Admin user seeded');
  }
};
seedAdmin();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Auth middleware
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer '))
    return res.status(401).json({ error: 'No token provided' });
  try {
    const token = authHeader.split(' ')[1];
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

const isAdmin = (req, res, next) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager')
    return res.status(403).json({ error: 'Access denied' });
  next();
};

// Multer config for file uploads
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => cb(null, uuidv4() + '-' + file.originalname)
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.xlsx', '.xls', '.csv'].includes(ext)) return cb(null, true);
    cb(new Error('Only Excel/CSV files are allowed'));
  }
});

// DeepSeek helper function
async function callDeepSeek(systemPrompt, userMessage, maxTokens = 1000) {
  if (!DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY not configured');
  const response = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify({
      model: 'deepseek-chat',   // or 'deepseek-reasoner' for deep thinking
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      max_tokens: maxTokens,
      temperature: 0.3
    })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message || 'DeepSeek API error');
  return data.choices[0].message.content;
}

// ---------- AUTH ROUTES ----------
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Invalid credentials' });
  if (!user.active) return res.status(403).json({ error: 'Account disabled' });

  const token = jwt.sign(
    { id: user.id, name: user.name, email: user.email, department: user.department, role: user.role },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, department: user.department, role: user.role }
  });
});

// ---------- DATA UPLOAD ----------
app.post('/api/data/upload', authenticate, upload.single('file'), (req, res) => {
  try {
    const { data_type, report_date } = req.body;
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file provided' });

    let rows = [];
    if (file.originalname.endsWith('.csv')) {
      const csvData = fs.readFileSync(file.path, 'utf-8');
      rows = csvData.split('\n').filter(line => line.trim()).map(line => {
        const cols = line.split(',');
        return { _raw: cols };
      });
    } else {
      const workbook = xlsx.readFile(file.path);
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      rows = xlsx.utils.sheet_to_json(sheet);
    }

    const uploadStmt = db.prepare(
      'INSERT INTO uploads (user_id, department, data_type, original_name, row_count, file_path) VALUES (?,?,?,?,?,?)'
    );
    const info = uploadStmt.run(req.user.id, req.user.department, data_type, file.originalname, rows.length, file.path);
    const uploadId = info.lastInsertRowid;

    const insertRow = db.prepare('INSERT INTO upload_data (upload_id, row_index, json_data) VALUES (?,?,?)');
    const insertMany = db.transaction((rows) => {
      for (let i = 0; i < rows.length; i++) {
        insertRow.run(uploadId, i, JSON.stringify(rows[i]));
      }
    });
    insertMany(rows);

    const preview = rows.slice(0, 5);
    res.json({ uploadId, rowCount: rows.length, preview });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- UPLOADS LIST ----------
app.get('/api/data/uploads', authenticate, (req, res) => {
  let query = 'SELECT u.*, us.name as uploader_name FROM uploads u JOIN users us ON u.user_id = us.id';
  const params = [];
  if (req.user.role !== 'admin' && req.user.role !== 'manager') {
    query += ' WHERE u.department = ?';
    params.push(req.user.department);
  }
  query += ' ORDER BY u.uploaded_at DESC LIMIT 50';
  const uploads = db.prepare(query).all(...params);
  res.json(uploads);
});

// ---------- DASHBOARD STATS ----------
app.get('/api/dashboard/stats', authenticate, (req, res) => {
  const totalUploads = db.prepare('SELECT COUNT(*) as count FROM uploads').get().count;
  const totalRows = db.prepare('SELECT SUM(row_count) as sum FROM uploads').get().sum || 0;
  const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users WHERE active=1').get().count;
  const totalInsights = db.prepare('SELECT COUNT(*) as count FROM insights').get().count;

  const deptStats = db.prepare(`
    SELECT department, COUNT(*) as uploads FROM uploads GROUP BY department ORDER BY uploads DESC
  `).all();

  const recentUploads = db.prepare(`
    SELECT u.*, us.name as uploader_name FROM uploads u JOIN users us ON u.user_id = us.id
    ORDER BY u.uploaded_at DESC LIMIT 10
  `).all();

  const recentInsights = db.prepare(`SELECT * FROM insights ORDER BY generated_at DESC LIMIT 5`).all();

  res.json({ totalUploads, totalRows, totalUsers, totalInsights, deptStats, recentUploads, recentInsights });
});

// ---------- AI ANALYSIS (DeepSeek) ----------
app.post('/api/ai/analyze', authenticate, async (req, res) => {
  if (!DEEPSEEK_API_KEY) return res.status(503).json({ error: 'AI service not configured (DEEPSEEK_API_KEY missing)' });
  const { upload_id, analysis_type } = req.body;
  if (!upload_id) return res.status(400).json({ error: 'upload_id required' });

  const upload = db.prepare('SELECT * FROM uploads WHERE id = ?').get(upload_id);
  if (!upload) return res.status(404).json({ error: 'Upload not found' });

  const rows = db.prepare('SELECT json_data FROM upload_data WHERE upload_id = ? ORDER BY row_index LIMIT 50').all(upload_id);
  const sampleData = rows.map(r => JSON.parse(r.json_data)).slice(0, 20);
  const dataSample = JSON.stringify(sampleData).substring(0, 3000);

  try {
    const system = "You are an AI analyst for FIBC Lanka, a manufacturer of woven polypropylene bags and FIBCs. Analyze the uploaded data and provide actionable insights. Be concise, specific, and data-driven.";
    const userMsg = `Analyze this data from a ${upload.data_type} (${upload.department} department). Provide key observations, anomalies, trends, and recommendations.\n\nSample data:\n${dataSample}`;
    const content = await callDeepSeek(system, userMsg, 1000);

    db.prepare('INSERT INTO insights (upload_id, insight_type, title, content, department) VALUES (?,?,?,?,?)')
      .run(upload_id, analysis_type || 'comprehensive', 'Analysis of ' + upload.original_name, content, upload.department);

    res.json({ analysis: content });
  } catch (err) {
    res.status(500).json({ error: 'AI analysis failed: ' + err.message });
  }
});

// ---------- AI CHAT ----------
app.post('/api/ai/chat', authenticate, async (req, res) => {
  if (!DEEPSEEK_API_KEY) return res.status(503).json({ error: 'AI service not configured' });
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });

  const recentUploads = db.prepare(`
    SELECT data_type, department, uploaded_at, row_count FROM uploads
    WHERE department = ? OR ? = 'admin' ORDER BY uploaded_at DESC LIMIT 5
  `).all(req.user.department, req.user.role);
  const uploadSummary = recentUploads.map(u => `${u.data_type} (${u.department}, ${u.row_count} rows)`).join(', ');

  const recentInsights = db.prepare(`SELECT title, content FROM insights ORDER BY generated_at DESC LIMIT 3`).all();
  const insightsSummary = recentInsights.map(i => i.title + ': ' + i.content.substring(0, 100)).join(' | ');

  const context = `Current user department: ${req.user.department}. Recent uploads: ${uploadSummary || 'none'}. Recent insights: ${insightsSummary || 'none'}.`;

  try {
    const system = `You are a helpful, knowledgeable AI assistant for FIBC Lanka (fibclanka.com), a Sri Lankan FIBC bag manufacturer. You answer questions about production, quality, inventory, and operations based on the company's uploaded data. Be precise, cite numbers when possible, and always be practical. The company uses these departments: Yarn, Loom, Printing, Cutting, BCS, Finishing, Loading, Stores, Sales, Finance, Administration.`;
    const reply = await callDeepSeek(system, `Context:\n${context}\n\nUser question: ${message}`, 800);
    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: 'AI chat failed: ' + err.message });
  }
});

// ---------- PREDICTION ----------
app.post('/api/ai/predict', authenticate, async (req, res) => {
  if (!DEEPSEEK_API_KEY) return res.status(503).json({ error: 'AI service not configured' });
  const { department, period, metric } = req.body;

  const uploads = db.prepare(`
    SELECT data_type, row_count, uploaded_at FROM uploads
    WHERE department = ? OR ? = 'All' ORDER BY uploaded_at DESC LIMIT 20
  `).all(department, department);

  const sampleRows = [];
  for (const u of uploads) {
    const rows = db.prepare('SELECT json_data FROM upload_data WHERE upload_id = ? LIMIT 5').all(u.id);
    sampleRows.push(...rows.map(r => JSON.parse(r.json_data)));
  }
  const dataSample = JSON.stringify(sampleRows.slice(0, 15)).substring(0, 3000);

  try {
    const system = `You are a production forecasting AI for FIBC Lanka. Use the provided data to generate realistic predictions. Consider seasonality, trends, and known factors. Include numerical forecasts and actionable recommendations for procurement and planning.`;
    const userMsg = `Generate a prediction report for ${department} department (${period}) focusing on ${metric || 'general production'}. Available data sample:\n${dataSample}`;
    const reply = await callDeepSeek(system, userMsg, 1200);
    res.json({ prediction: reply });
  } catch (err) {
    res.status(500).json({ error: 'Prediction failed: ' + err.message });
  }
});

// ---------- INSIGHTS LIST ----------
app.get('/api/ai/insights', authenticate, (req, res) => {
  const insights = db.prepare('SELECT * FROM insights ORDER BY generated_at DESC LIMIT 30').all();
  res.json(insights);
});

// ---------- TARGETS ----------
app.get('/api/targets', authenticate, (req, res) => {
  const targets = db.prepare('SELECT * FROM targets ORDER BY department, metric_name').all();
  res.json(targets);
});

app.post('/api/targets', authenticate, isAdmin, (req, res) => {
  const { department, metric_name, target_value, period } = req.body;
  if (!department || !metric_name || !target_value) return res.status(400).json({ error: 'Missing fields' });
  const info = db.prepare('INSERT INTO targets (department, metric_name, target_value, period) VALUES (?,?,?,?)')
    .run(department, metric_name, target_value, period);
  res.json({ id: info.lastInsertRowid, message: 'Target set' });
});

// ---------- ADMIN USER MANAGEMENT ----------
app.get('/api/admin/users', authenticate, isAdmin, (req, res) => {
  const users = db.prepare('SELECT id, name, email, department, role, active, created_at FROM users ORDER BY created_at DESC').all();
  res.json(users);
});

app.post('/api/admin/users', authenticate, isAdmin, (req, res) => {
  const { name, email, password, department, role } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Required fields missing' });
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'Email already exists' });
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users (name, email, password, department, role) VALUES (?,?,?,?,?)')
    .run(name, email, hash, department || 'General', role || 'user');
  res.json({ message: 'User created' });
});

app.patch('/api/admin/users/:id', authenticate, isAdmin, (req, res) => {
  const { active } = req.body;
  db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, req.params.id);
  res.json({ message: 'Updated' });
});

app.delete('/api/admin/users/:id', authenticate, isAdmin, (req, res) => {
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// Catch-all for SPA routes
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('*', (req, res) => res.redirect('/'));

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`🚀 FIBC AI Platform (DeepSeek) running on http://localhost:${PORT}`);
});