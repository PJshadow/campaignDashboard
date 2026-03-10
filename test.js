const mysql = require('mysql2');
require('dotenv').config();
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

console.log('Testing connection to DB...');
db.query('SELECT 1 as test', (err, res) => {
    if (err) console.error('Error on SELECT 1:', err);
    else console.log('SELECT 1 works:', res);

    console.log('Testing SELECT * FROM campanhas...');
    db.query('SELECT * FROM campanhas LIMIT 2', (err2, res2) => {
        if (err2) console.error('Error on SELECT campanhas:', err2);
        else console.log('SELECT campanhas works:', res2 ? res2.length : 'none', 'rows');
        process.exit();
    });
});
