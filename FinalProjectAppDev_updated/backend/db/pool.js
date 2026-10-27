const mysql = require('mysql2/promise');
require('dotenv').config();
 
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true,
  // DATE columns (internship start/end, deadline) as plain 'YYYY-MM-DD' text, so a date never
  // shifts by a day depending on the server / browser timezone. DATETIME columns are unchanged.
  dateStrings: ['DATE'],
});
 
module.exports = pool;
