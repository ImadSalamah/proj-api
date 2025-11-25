const oracledb = require('oracledb');
const path = require('path');
require('dotenv').config();

// 🔥 إعدادات قاعدة البيانات - آمنة
const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  connectString: process.env.DB_CONNECTION_STRING
};

// 🔥 تهيئة عميل Oracle
try {
  oracledb.initOracleClient({
    libDir: process.env.ORACLE_CLIENT_PATH || "/Users/macbook/instantclient_19_8"
  });
} catch (err) {
  console.log('⚠️ Oracle client initialization skipped (may be already initialized)');
}

// 🔥 إنشاء connection pool
let pool;

const initPool = async () => {
  try {
    pool = await oracledb.createPool({
      ...dbConfig,
      poolMin: 2,
      poolMax: 10,
      poolIncrement: 2,
      poolTimeout: 60,
      queueTimeout: 60000,
      poolPingInterval: 60
    });
    console.log('✅ Oracle Connection Pool created successfully');
  } catch (err) {
    console.error('❌ Error creating connection pool:', err);
    throw err;
  }
};

// 🔥 دالة الاتصال المحسنة
const getConnection = async () => {
  try {
    if (!pool) {
      await initPool();
    }
    return await pool.getConnection();
  } catch (err) {
    console.error('❌ Error getting database connection:', err);
    throw err;
  }
};

// 🔥 دالة إغلاق البول
const closePool = async () => {
  try {
    if (pool) {
      await pool.close();
      console.log('✅ Connection pool closed');
    }
  } catch (err) {
    console.error('❌ Error closing connection pool:', err);
  }
};

module.exports = {
  getConnection,
  closePool,
  oracledb
};