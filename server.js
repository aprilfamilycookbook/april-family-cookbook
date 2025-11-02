const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const multer = require('multer');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const db = new Database('./data/cookbook.db');

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = 'public/uploads/';
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
  }),
  limits: { fileSize: 10 * 1024 * 1024 }
});

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
  secret: 'family-cookbook-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 86400000 }
}));

db.exec(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, password TEXT, name TEXT);
CREATE TABLE IF NOT EXISTS recipes (id INTEGER PRIMARY KEY, title TEXT, description TEXT, ingredients TEXT, instructions TEXT, prep_time INTEGER, cook_time INTEGER, servings INTEGER, category TEXT, author_name TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS pending_recipes (id INTEGER PRIMARY KEY, title TEXT, raw_text TEXT, file_name TEXT, submitter_name TEXT, status TEXT DEFAULT 'pending', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS ratings (id INTEGER PRIMARY KEY, recipe_id INTEGER, rating INTEGER, user_name TEXT);
CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY, recipe_id INTEGER, user_name TEXT, comment TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);`);

if (db.prepare('SELECT COUNT(*) as c FROM users').get().c === 0) {
  db.prepare('INSERT INTO users (username, password, name) VALUES (?, ?, ?)').run('admin', bcrypt.hashSync('admin123', 10), 'Admin');
}

const auth = (req, res, next) => req.session.userId ? next() : res.status(401).json({ error: 'Auth required' });

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'views', 'index.html')));
app.post('/api/login', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(req.body.username);
  if (user && bcrypt.compareSync(req.body.password, user.password)) {
    req.session.userId = user.id;
    req.session.userName = user.name;
    res.json({ success: true, name: user.name });
  } else res.status(401).json({ error: 'Invalid' });
});
app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });
app.get('/api/check-auth', (req, res) => res.json(req.session.userId ? { authenticated: true, name: req.session.userName } : { authenticated: false }));
app.post('/api/upload-document', auth, upload.single('document'), async (req, res) => {
  try {
    let text = '';
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (ext === '.txt') text = fs.readFileSync(req.file.path, 'utf8');
    else if (ext === '.docx') text = (await mammoth.extractRawText({ path: req.file.path })).value;
    else if (ext === '.pdf') text = (await pdfParse(fs.readFileSync(req.file.path))).text;
    fs.unlinkSync(req.file.path);
    const r = db.prepare('INSERT INTO pending_recipes (title, raw_text, file_name, submitter_name) VALUES (?, ?, ?, ?)').run(req.body.title || req.file.originalname, text, req.file.originalname, req.session.userName);
    res.json({ success: true, id: r.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/pending-recipes', auth, (req, res) => res.json(db.prepare('SELECT * FROM pending_recipes WHERE status = ? ORDER BY created_at DESC').all('pending')));
app.get('/api/pending-recipes/count', auth, (req, res) => res.json({ count: db.prepare('SELECT COUNT(*) as c FROM pending_recipes WHERE status = ?').get('pending').c }));
app.get('/api/pending-recipes/:id', auth, (req, res) => res.json(db.prepare('SELECT * FROM pending_recipes WHERE id = ?').get(req.params.id)));
app.post('/api/pending-recipes/:id/publish', auth, (req, res) => {
  const { title, description, ingredients, instructions, prep_time, cook_time, servings, category } = req.body;
  db.prepare('INSERT INTO recipes (title, description, ingredients, instructions, prep_time, cook_time, servings, category, author_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(title, description, ingredients, instructions, prep_time, cook_time, servings, category, req.session.userName);
  db.prepare('UPDATE pending_recipes SET status = ? WHERE id = ?').run('published', req.params.id);
  res.json({ success: true });
});
app.delete('/api/pending-recipes/:id', auth, (req, res) => {
  db.prepare('DELETE FROM pending_recipes WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});
app.get('/api/recipes', (req, res) => {
  let q = 'SELECT * FROM recipes', p = [];
  if (req.query.search) {
    q += ' WHERE title LIKE ? OR ingredients LIKE ?';
    p.push(`%${req.query.search}%`, `%${req.query.search}%`);
  }
  q += ' ORDER BY created_at DESC';
  const recipes = db.prepare(q).all(...p);
  recipes.forEach(r => {
    const rd = db.prepare('SELECT AVG(rating) as avg, COUNT(*) as cnt FROM ratings WHERE recipe_id = ?').get(r.id);
    r.avgRating = rd.avg || 0;
    r.ratingCount = rd.cnt || 0;
  });
  res.json(recipes);
});
app.get('/api/recipes/:id', (req, res) => {
  const recipe = db.prepare('SELECT * FROM recipes WHERE id = ?').get(req.params.id);
  const rd = db.prepare('SELECT AVG(rating) as avg, COUNT(*) as cnt FROM ratings WHERE recipe_id = ?').get(recipe.id);
  recipe.avgRating = rd.avg || 0;
  recipe.ratingCount = rd.cnt || 0;
  recipe.comments = db.prepare('SELECT * FROM comments WHERE recipe_id = ? ORDER BY created_at DESC').all(recipe.id);
  res.json(recipe);
});
app.post('/api/recipes', auth, (req, res) => {
  const { title, description, ingredients, instructions, prep_time, cook_time, servings, category } = req.body;
  const r = db.prepare('INSERT INTO recipes (title, description, ingredients, instructions, prep_time, cook_time, servings, category, author_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(title, description, ingredients, instructions, prep_time, cook_time, servings, category, req.session.userName);
  res.json({ success: true, id: r.lastInsertRowid });
});
app.post('/api/recipes/:id/rate', (req, res) => {
  db.prepare('INSERT INTO ratings (recipe_id, rating, user_name) VALUES (?, ?, ?)').run(req.params.id, req.body.rating, req.body.userName || 'Anonymous');
  res.json({ success: true });
});
app.post('/api/recipes/:id/comment', (req, res) => {
  db.prepare('INSERT INTO comments (recipe_id, user_name, comment) VALUES (?, ?, ?)').run(req.params.id, req.body.userName, req.body.comment);
  res.json({ success: true });
});
app.get('/api/categories', (req, res) => res.json(db.prepare('SELECT DISTINCT category FROM recipes WHERE category IS NOT NULL').all().map(c => c.category)));
app.listen(PORT, () => console.log(`🍳 April Family Cookbook on http://localhost:${PORT}`));
