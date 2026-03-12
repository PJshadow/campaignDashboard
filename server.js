const express = require('express');
const app = express();
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
app.set('trust proxy', 1);
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const ExcelJS = require('exceljs');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

// Create MySQL connection pool
const mysql = require('mysql2');
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
    console.log('✅ Conexão com o banco de dados MySQL (' + process.env.DB_NAME + ') estabelecida com sucesso!');
    connection.release();
  }
});

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Static files — served before routes
app.use(express.static(path.join(__dirname, 'public')));

// Rate Limiting
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100, // Limit each IP to 100 requests per `window`
  standardHeaders: 'draft-7', // set `RateLimit` and `RateLimit-Policy` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  message: 'Muitas requisições deste IP, tente novamente em 15 minutos.'
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 5, // Limit each IP to 5 login attempts per window
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: 'Muitas tentativas de login, tente novamente em 15 minutos.'
});

const apiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 10, // Limit each IP to 10 prospectings per hour
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: 'Você atingiu o limite de prospecções por hora. Tente novamente mais tarde.'
});

// Apply general limiter to all requests
app.use(generalLimiter);

// Session management
const session = require('express-session');
app.use(session({
  secret: process.env.EXPRESS_SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.COOKIE_SECURE === 'true',  // reads from .env — set to 'false' for local, 'true' for VPS
    httpOnly: true,
    sameSite: 'lax'
  }
}));

// Passport Config
passport.use(new LocalStrategy({
  usernameField: 'email',
  passwordField: 'password'
},
  (email, password, done) => {
    db.query('SELECT * FROM ai_dashboard_users WHERE email = ?', [email], async (err, results) => {
      if (err) return done(err);
      if (results.length === 0) return done(null, false, { message: 'Usuário não encontrado.' });

      const user = results[0];
      const match = await bcrypt.compare(password, user.password);
      if (match) return done(null, user);
      return done(null, false, { message: 'Senha incorreta.' });
    });
  }
));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
  db.query('SELECT * FROM ai_dashboard_users WHERE id = ?', [id], (err, results) => {
    if (results.length === 0) return done(null, false);
    done(err, results[0]);
  });
});

app.use(passport.initialize());
app.use(passport.session());

// Password encryption
const bcrypt = require('bcryptjs');

// Server port
const PORT = process.env.PORT;

// EJS setup — using express-ejs-layouts pattern via manual render helper
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Helper: render a view wrapped in the layout
function renderWithLayout(res, view, data = {}) {
  // First render the page partial
  res.render(view, data, (err, pageHtml) => {
    if (err) {
      console.error(`Erro ao renderizar ${view}:`, err);
      return res.status(500).send('Erro interno do servidor.');
    }
    // Then render the layout, injecting the page HTML as `body`
    res.render('layout', { ...data, body: pageHtml });
  });
}

// Auth middleware
function isAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
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
//  ROUTES
// =============================================

// Home — Dashboard
app.get('/', isAuthenticated, (req, res) => {
  const sqlAtivas = "SELECT * FROM campanhas WHERE emAndamento = 1";
  const sqlGrafico = "SELECT TipoDeCampanha, leadsAlcancados, Inicio FROM campanhas";

  db.query(sqlAtivas, (err, campanhasAtivas) => {
    if (err) {
      console.error('Erro ao buscar campanhas ativas (DB):', err);
      return res.status(500).send('Erro ao carregar o painel.');
    }

    db.query(sqlGrafico, (err2, campanhasParaGrafico) => {
      if (err2) {
        console.error('Erro ao buscar dados do gráfico (DB):', err2);
        return res.status(500).send('Erro ao carregar o painel.');
      }

      const dadosGrafico = campanhasParaGrafico.map(c => ({
        tipo: c.TipoDeCampanha,
        leads: c.leadsAlcancados,
        inicio: c.Inicio
      }));

      // Ler arquivos disponíveis na pasta downloads
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
          }).sort((a, b) => b.date - a.date); // Mais recentes primeiro
        } catch (readErr) {
          console.error("Erro ao ler diretório de downloads para exibir na home:", readErr);
        }
      }

      console.log('Acesso à página Home');

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

// FAQ
app.get('/faq', isAuthenticated, (req, res) => {
  console.log('Acesso à página FAQ');
  renderWithLayout(res, 'faq', {
    name: req.user.name,
    activePage: 'faq'
  });
});

// History
app.get('/history', isAuthenticated, (req, res) => {
  const sql = "SELECT * FROM campanhas ORDER BY Inicio DESC";

  db.query(sql, (err, campanhasFinalizadas) => {
    if (err) {
      console.error('Erro ao buscar histórico (DB):', err);
      return res.status(500).send('Erro interno ao carregar o histórico.');
    }

    console.log('Acesso à página History - encontrou ' + campanhasFinalizadas.length + ' campanhas');

    renderWithLayout(res, 'history', {
      name: req.user.name,
      campanhas: campanhasFinalizadas,
      activePage: 'history'
    });
  });
});

// Prospecção GET
app.get('/campanhaProspeccao', isAuthenticated, (req, res) => {
  console.log('Acesso à página Prospecção');
  renderWithLayout(res, 'campanhaProspeccao', {
    name: req.user.name,
    activePage: 'prospeccao'
  });
});

// Prospecção POST (Azure Maps Integration)
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
    // 1. Get Coordinates
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

    // 2. Fuzzy Search for Businesses
    const fuzzyQuery = encodeURIComponent(`${tipoEmpresa}`);
    const fuzzyUrl = `https://atlas.microsoft.com/search/fuzzy/json?api-version=1.0&subscription-key=${apiKey}&query=${fuzzyQuery}&lat=${lat}&lon=${lon}&radius=30000&countrySet=BR&limit=100`;

    const fuzzyResponse = await axios.get(fuzzyUrl);
    let results = fuzzyResponse.data.results || [];

    // 3. Filter strictly by City
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

    // 4. Create Excel Workbook
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

    // 5. Save File
    const timestamp = Date.now();
    const safeCity = cidade.replace(/\s+/g, '_').toLowerCase();
    const filename = `leads_${safeCity}_${timestamp}.xlsx`;
    const filepath = path.join(__dirname, 'public', 'downloads', filename);

    const downloadsDir = path.dirname(filepath);
    if (!fs.existsSync(downloadsDir)) {
      fs.mkdirSync(downloadsDir, { recursive: true });
    }

    await workbook.xlsx.writeFile(filepath);

    // 6. DB Record
    const dbSql = "INSERT INTO campanhas (TipoDeCampanha, TipoDeLead, Inicio, estado, Cidade, leadsAlcancados, emAndamento) VALUES (?, ?, NOW(), ?, ?, ?, 0)";
    db.query(dbSql, ['Prospecção (Planilha)', tipoEmpresa, estado, cidade, leadsFiltrados.length], (err) => {
      if (err) console.error('Erro ao registrar campanha no BD:', err);
    });

    // 7. Render Success
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
    console.error('Erro na API da Azure:', err);
    renderWithLayout(res, 'campanhaProspeccao', {
      name: req.user.name,
      activePage: 'prospeccao',
      error: 'Problema de conexão com a API de Mapas. Verifique a chave ou o status do serviço.'
    });
  }
});

// API — Recent campaigns (JSON, for polling)
app.get('/api/campanhas', isAuthenticated, (req, res) => {
  const sql = "SELECT * FROM campanhas ORDER BY Inicio DESC LIMIT 10";
  db.query(sql, (err, result) => {
    if (err) {
      console.error('Erro ao buscar campanhas (API DB):', err);
      return res.status(500).json({ error: 'Erro interno ao buscar campanhas' });
    }
    res.json(result);
  });
});

// API — Cities by state
app.get('/api/cidades/:estado', isAuthenticated, (req, res) => {
  const estado = req.params.estado.toUpperCase();

  db.query('SELECT DISTINCT cidade FROM listadecidades WHERE estado = ?', [estado], (err, results) => {
    if (err) {
      console.error('Erro ao buscar cidades (API DB):', err);
      return res.status(500).json({ error: 'Erro interno ao buscar cidades' });
    }
    res.json(results.map(r => r.cidade));
  });
});


// =============================================
//  AUTH ROUTES
// =============================================

// Login page
app.get('/login', (req, res) => {
  console.log('Acesso à página Login');
  res.render('login');
});

// Login POST
app.post('/login', authLimiter, (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err) return next(err);
    if (!user) return res.send(info.message || 'Erro no login.');

    req.logIn(user, (err) => {
      if (err) return next(err);

      const { remember } = req.body;
      if (remember) {
        req.session.cookie.maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
      } else {
        req.session.cookie.expires = false;
      }

      console.log(`Usuário ${user.name} logado com sucesso via Passport!`);
      return res.redirect('/');
    });
  })(req, res, next);
});

// Logout
app.get('/logout', (req, res, next) => {
  console.log('Logout');
  req.logout((err) => {
    if (err) return next(err);
    res.redirect('/login');
  });
});


// =============================================
//  CAMPAIGN CONTROL (MySQL only — no N8N)
// =============================================

// Stop all active/paused campaigns
app.post('/stopcampaign', isAuthenticated, (req, res) => {
  db.query('UPDATE campanhas SET emAndamento = 0 WHERE emAndamento IN (1, 2)', (err, result) => {
    if (err) {
      console.error('Erro ao parar campanhas (DB):', err);
      return res.status(500).send('Erro interno do servidor.');
    }
    if (result.affectedRows === 0) {
      return res.send('Não há campanhas ativas ou pausadas no momento.');
    }
    console.log('Comando de parada executado');
    res.send('Comando de parada enviado com sucesso! Aguarde o encerramento.');
  });
});

// Pause active campaigns
app.post('/pausecampaign', isAuthenticated, (req, res) => {
  db.query('UPDATE campanhas SET emAndamento = 2 WHERE emAndamento = 1', (err, result) => {
    if (err) {
      console.error('Erro ao pausar campanhas:', err.message);
      return res.status(500).send('Erro no banco de dados.');
    }
    if (result.affectedRows === 0) {
      return res.send('Não há campanhas ativas para pausar.');
    }
    console.log('Comando de pausa executado');
    res.send('Campanhas pausadas com sucesso!');
  });
});

// Resume paused campaigns
app.post('/resumecampaign', isAuthenticated, (req, res) => {
  db.query('UPDATE campanhas SET emAndamento = 1 WHERE emAndamento = 2', (err, result) => {
    if (err) {
      console.error('Erro ao retomar campanhas:', err.message);
      return res.status(500).send('Erro no banco de dados.');
    }
    if (result.affectedRows === 0) {
      return res.send('Não há campanhas pausadas para retomar.');
    }
    console.log('Comando de retomada executado');
    res.send('Campanhas retomadas com sucesso!');
  });
});


// =============================================
//  START SERVER
// =============================================
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
