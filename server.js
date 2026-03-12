const express = require('express');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const ExcelJS = require('exceljs');
const mysql = require('mysql2');
const bcrypt = require('bcryptjs');
const passport = require('passport');
const session = require('express-session');
const LocalStrategy = require('passport-local').Strategy;
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
app.set('trust proxy', 1);

// =============================================
//  DATABASE CONNECTION
// =============================================
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

db.getConnection((err, connection) => {
  if (err) {
    console.error('======================================');
    console.error('ERRO DE CONEXÃO COM O BANCO DE DADOS:');
    console.error(err.message);
    if (err.code === 'ECONNREFUSED') {
      console.error('Dica: O servidor MySQL parece estar desligado ou o host/porta no .env estão errados.');
    }
    if (err.code === 'ER_ACCESS_DENIED_ERROR') {
      console.error('Dica: O usuário ou a senha no .env estão incorretos.');
    }
    if (err.code === 'ER_BAD_DB_ERROR') {
      console.error(`Dica: O banco de dados "${process.env.DB_NAME}" não existe.`);
    }
    console.error('======================================');
  } else {
    console.log(`✅ Conexão com o banco de dados MySQL (${process.env.DB_NAME}) estabelecida com sucesso!`);
    connection.release();
  }
});

// =============================================
//  MIDDLEWARES & SECURITY
// =============================================
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Rate Limiting
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: 'Muitas requisições deste IP, tente novamente em 15 minutos.'
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: 'Muitas tentativas de login, tente novamente em 15 minutos.'
});

const apiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: 'Você atingiu o limite de prospecções por hora. Tente novamente mais tarde.'
});

app.use(generalLimiter);

// Session management
app.use(session({
  secret: process.env.EXPRESS_SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.COOKIE_SECURE === 'true',
    httpOnly: true,
    sameSite: 'lax'
  }
}));

// =============================================
//  PASSPORT AUTH CONFIGURATION
// =============================================
passport.use(new LocalStrategy({
  usernameField: 'email',
  passwordField: 'password'
}, (email, password, done) => {
  db.query('SELECT * FROM ai_dashboard_users WHERE email = ?', [email], async (err, results) => {
    if (err) return done(err);
    if (results.length === 0) return done(null, false, { message: 'Usuário não encontrado.' });

    const user = results[0];
    const match = await bcrypt.compare(password, user.password);
    if (match) return done(null, user);
    return done(null, false, { message: 'Senha incorreta.' });
  });
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
  db.query('SELECT * FROM ai_dashboard_users WHERE id = ?', [id], (err, results) => {
    if (results.length === 0) return done(null, false);
    done(err, results[0]);
  });
});

app.use(passport.initialize());
app.use(passport.session());

// =============================================
//  VIEW ENGINE SETUP
// =============================================
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Helper: render a view wrapped in the layout
function renderWithLayout(res, view, data = {}) {
  res.render(view, data, (err, pageHtml) => {
    if (err) {
      console.error(`Erro ao renderizar ${view}:`, err);
      return res.status(500).send('Erro interno do servidor.');
    }
    res.render('layout', { ...data, body: pageHtml });
  });
}

// Auth guard middleware
function isAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/login');
}

// =============================================
//  BACKGROUND TASKS
// =============================================
// Cleanup old excel files every hour
setInterval(() => {
  const downloadsDir = path.join(__dirname, 'public', 'downloads');
  if (fs.existsSync(downloadsDir)) {
    fs.readdir(downloadsDir, (err, files) => {
      if (err) return console.error('Erro ao ler diretório de downloads:', err);

      const now = Date.now();
      const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days

      files.forEach(file => {
        const filePath = path.join(downloadsDir, file);
        fs.stat(filePath, (err, stats) => {
          if (err) return;
          if (now - stats.mtimeMs > maxAge) {
            fs.unlink(filePath, err => {
              if (err) console.error(`Erro ao deletar ${file}`, err);
              else console.log(`${file} deletado (mais de 7 dias).`);
            });
          }
        });
      });
    });
  }
}, 60 * 60 * 1000);

// =============================================
//  CORE ROUTES
// =============================================

// Dashboard Home
app.get('/', isAuthenticated, (req, res) => {
  const sqlAtivas = "SELECT * FROM campanhas WHERE emAndamento = 1";
  const sqlGrafico = "SELECT TipoDeCampanha, leadsAlcancados, Inicio FROM campanhas";

  db.query(sqlAtivas, (err, campanhasAtivas) => {
    if (err) {
      console.error('Erro ao buscar campanhas ativas:', err);
      return res.status(500).send('Erro ao carregar o painel.');
    }

    db.query(sqlGrafico, (err2, campanhasParaGrafico) => {
      if (err2) {
        console.error('Erro ao buscar dados do gráfico:', err2);
        return res.status(500).send('Erro ao carregar o painel.');
      }

      const dadosGrafico = campanhasParaGrafico.map(c => ({
        tipo: c.TipoDeCampanha,
        leads: c.leadsAlcancados,
        inicio: c.Inicio
      }));

      const downloadsDir = path.join(__dirname, 'public', 'downloads');
      let arquivosParaDownload = [];
      if (fs.existsSync(downloadsDir)) {
        try {
          const files = fs.readdirSync(downloadsDir);
          arquivosParaDownload = files.map(file => {
            const stats = fs.statSync(path.join(downloadsDir, file));
            return {
              name: file,
              url: `/downloads/${file}`,
              date: stats.mtime
            };
          }).sort((a, b) => b.date - a.date);
        } catch (readErr) {
          console.error("Erro ao ler diretório de downloads:", readErr);
        }
      }

      renderWithLayout(res, 'home', {
        name: req.user.name,
        campanhas: campanhasAtivas,
        dadosGrafico: JSON.stringify(dadosGrafico),
        arquivosParaDownload,
        activePage: 'home'
      });
    });
  });
});

// FAQ Page
app.get('/faq', isAuthenticated, (req, res) => {
  renderWithLayout(res, 'faq', {
    name: req.user.name,
    activePage: 'faq'
  });
});

// History Page
app.get('/history', isAuthenticated, (req, res) => {
  const sql = "SELECT * FROM campanhas ORDER BY Inicio DESC";
  db.query(sql, (err, campanhasFinalizadas) => {
    if (err) {
      console.error('Erro ao buscar histórico:', err);
      return res.status(500).send('Erro interno ao carregar o histórico.');
    }
    renderWithLayout(res, 'history', {
      name: req.user.name,
      campanhas: campanhasFinalizadas,
      activePage: 'history'
    });
  });
});

// Prospecção (Leads Search)
app.get('/campanhaProspeccao', isAuthenticated, (req, res) => {
  renderWithLayout(res, 'campanhaProspeccao', {
    name: req.user.name,
    activePage: 'prospeccao'
  });
});

// =============================================
//  API ROUTES
// =============================================

// Azure Maps Integration for Lead Prospecting
app.post('/api/iniciar-prospeccao', isAuthenticated, apiLimiter, async (req, res) => {
  const { tipoEmpresa, estado, cidade } = req.body;
  const apiKey = process.env.AZURE_MAPS_KEY;

  if (!apiKey) {
    console.error('AZURE_MAPS_KEY não configurada no .env');
    return renderWithLayout(res, 'campanhaProspeccao', {
      name: req.user.name, activePage: 'prospeccao',
      error: 'Chave de API do Azure não configurada no servidor.'
    });
  }

  try {
    const addressQuery = `${cidade} ${estado}`;
    const addressUrl = `https://atlas.microsoft.com/search/address/json?api-version=1.0&subscription-key=${apiKey}&query=${encodeURIComponent(addressQuery)}&countrySet=BR&limit=1`;

    const addressResponse = await axios.get(addressUrl);
    if (!addressResponse.data.results || addressResponse.data.results.length === 0) {
      return renderWithLayout(res, 'campanhaProspeccao', {
        name: req.user.name, activePage: 'prospeccao',
        error: `Não foi possível encontrar a cidade: ${cidade} - ${estado}`
      });
    }

    const { lat, lon } = addressResponse.data.results[0].position;

    const fuzzyQuery = encodeURIComponent(`${tipoEmpresa}`);
    const fuzzyUrl = `https://atlas.microsoft.com/search/fuzzy/json?api-version=1.0&subscription-key=${apiKey}&query=${fuzzyQuery}&lat=${lat}&lon=${lon}&radius=30000&countrySet=BR&limit=100`;

    const fuzzyResponse = await axios.get(fuzzyUrl);
    let results = fuzzyResponse.data.results || [];

    const cidadeNormalizada = cidade.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

    const leadsFiltrados = results.filter(lead => {
      const leadCity = lead.address.localName || lead.address.municipality || "";
      const cityNorm = leadCity.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      return cityNorm === cidadeNormalizada;
    });

    if (leadsFiltrados.length === 0) {
      return renderWithLayout(res, 'campanhaProspeccao', {
        name: req.user.name, activePage: 'prospeccao',
        error: `A busca não encontrou nenhuma empresa do tipo "${tipoEmpresa}" em ${cidade} - ${estado}.`
      });
    }

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Leads');
    worksheet.columns = [
      { header: 'Nome', key: 'name', width: 35 },
      { header: 'Endereço', key: 'address', width: 45 },
      { header: 'Telefone', key: 'phone', width: 20 },
      { header: 'Categoria', key: 'category', width: 30 },
      { header: 'URL', key: 'url', width: 40 }
    ];
    worksheet.getRow(1).font = { bold: true };

    leadsFiltrados.forEach(lead => {
      worksheet.addRow({
        name: lead.poi ? lead.poi.name : 'N/A',
        address: lead.address ? lead.address.freeformAddress : 'N/A',
        phone: lead.poi && lead.poi.phone ? lead.poi.phone : 'Não informado',
        category: lead.poi && lead.poi.classifications ? lead.poi.classifications.map(c => c.names[0].name).join(', ') : '',
        url: lead.poi && lead.poi.url ? lead.poi.url : ''
      });
    });

    const timestamp = Date.now();
    const safeCity = cidade.replace(/\s+/g, '_').toLowerCase();
    const filename = `leads_${safeCity}_${timestamp}.xlsx`;
    const filepath = path.join(__dirname, 'public', 'downloads', filename);

    if (!fs.existsSync(path.dirname(filepath))) fs.mkdirSync(path.dirname(filepath), { recursive: true });
    await workbook.xlsx.writeFile(filepath);

    const dbSql = "INSERT INTO campanhas (TipoDeCampanha, TipoDeLead, Inicio, estado, Cidade, leadsAlcancados, emAndamento) VALUES (?, ?, NOW(), ?, ?, ?, 0)";
    db.query(dbSql, ['Prospecção (Planilha)', tipoEmpresa, estado, cidade, leadsFiltrados.length], (err) => {
      if (err) console.error('Erro ao registrar campanha no BD:', err);
    });

    renderWithLayout(res, 'campanhaProspeccao', {
      name: req.user.name,
      activePage: 'prospeccao',
      success: true,
      tipoEmpresa,
      estado,
      cidade,
      leadsCount: leadsFiltrados.length,
      downloadUrl: `/downloads/${filename}`
    });
  } catch (err) {
    console.error('Erro na API de Prospecção:', err);
    renderWithLayout(res, 'campanhaProspeccao', {
      name: req.user.name,
      activePage: 'prospeccao',
      error: 'Problema de conexão com o serviço de mapas.'
    });
  }
});

// JSON API — Recent campaigns (for dashboard polling)
app.get('/api/campanhas', isAuthenticated, (req, res) => {
  const sql = "SELECT * FROM campanhas ORDER BY Inicio DESC LIMIT 10";
  db.query(sql, (err, result) => {
    if (err) return res.status(500).json({ error: 'Erro ao buscar campanhas' });
    res.json(result);
  });
});

// JSON API — List cities by state
app.get('/api/cidades/:estado', isAuthenticated, (req, res) => {
  const estado = req.params.estado.toUpperCase();
  db.query('SELECT DISTINCT cidade FROM listadecidades WHERE estado = ?', [estado], (err, results) => {
    if (err) return res.status(500).json({ error: 'Erro ao buscar cidades' });
    res.json(results.map(r => r.cidade));
  });
});

// =============================================
//  AUTHENTICATION ROUTES
// =============================================

app.get('/login', (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/');
  res.render('login');
});

app.post('/login', authLimiter, (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err) return next(err);
    if (!user) return res.send(info.message || 'Erro no login.');

    req.logIn(user, (err) => {
      if (err) return next(err);

      const { remember } = req.body;
      req.session.cookie.maxAge = remember ? 7 * 24 * 60 * 60 * 1000 : null;
      if (!remember) req.session.cookie.expires = false;

      console.log(`Usuário ${user.name} logado via Passport.`);
      return res.redirect('/');
    });
  })(req, res, next);
});

app.get('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    res.redirect('/login');
  });
});

// =============================================
//  SERVER START
// =============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
