const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// 🔥 استيراد الحجات
let oracledb;
try {
  oracledb = require("oracledb");
  console.log("✅ OracleDB module loaded");
} catch (err) {
  console.log("❌ OracleDB not available:", err.message);
  oracledb = null;
}

// 🔥 تهيئة Oracle Client
if (oracledb) {
  try {
    oracledb.initOracleClient({
      libDir: "/Users/macbook/instantclient_19_8"
    });
    console.log("✅ Oracle Client initialized successfully");
  } catch (initErr) {
    console.log("⚠️ Oracle Client init:", initErr.message);
  }
}

// Middleware
app.use(express.json());
app.use(require('cors')());

// 🔥 محاولات اتصال مختلفة بقاعدة البيانات
const dbConfigs = [
  // المحاولة 1: TNS name الأصلي
  {
    user: "ADMIN",
    password: "Ee@65842108", 
    connectString: "dcsaauj_high",
    name: "TNS Name"
  },
  // المحاولة 2: Easy Connect String (جرب هذا!)
  {
    user: "ADMIN", 
    password: "Emad@65842108",
    connectString: "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=your-host)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=your_service)))",
    name: "Easy Connect"
  }
];

// 🔥 دالة اتصال ذكية
async function getConnection() {
  if (!oracledb) {
    throw new Error('OracleDB not available');
  }
  
  let lastError;
  
  for (const config of dbConfigs) {
    try {
      console.log(`🔗 Trying connection: ${config.name}`);
      const connection = await oracledb.getConnection(config);
      console.log(`✅ SUCCESS with ${config.name}`);
      return connection;
    } catch (err) {
      console.log(`❌ Failed with ${config.name}:`, err.message);
      lastError = err;
      continue; // جرب الإعداد التالي
    }
  }
  
  throw lastError; // إذا فشلت جميع المحاولات
}

// 🔥 الـ endpoints
app.get('/', (req, res) => {
  res.json({ 
    message: '🚀 Server is running!',
    timestamp: new Date().toISOString(),
    status: 'OK',
    database: 'Check /test-db for connection status'
  });
});

app.get('/test-db', async (req, res) => {
  let connection;
  try {
    connection = await getConnection();
    const result = await connection.execute(`SELECT SYSDATE as current_time FROM DUAL`);
    await connection.close();
    
    res.json({ 
      status: '✅ SUCCESS',
      message: 'Database connection working!',
      serverTime: result.rows[0][0],
      connectionMethod: 'Multiple attempts'
    });
  } catch (err) {
    res.json({ 
      status: '❌ FAILED',
      message: 'All database connection attempts failed',
      error: err.message,
      suggestion: 'Check connect string in dbConfigs array'
    });
  }
});

// 🔥 endpoint لمعرفة معلومات الاتصال
app.get('/db-info', (req, res) => {
  res.json({
    attempts: dbConfigs.map(config => ({
      name: config.name,
      connectString: config.connectString.substring(0, 50) + '...',
      user: config.user
    })),
    suggestion: 'Update the connectString in dbConfigs with your actual Oracle Cloud details'
  });
});

// 🔥 تشغيل السيرفر
app.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(60));
  console.log(`🚀 SERVER RUNNING on http://localhost:${PORT}`);
  console.log('='.repeat(60));
  console.log(`📋 Test endpoints:`);
  console.log(`   GET  http://localhost:${PORT}/`);
  console.log(`   GET  http://localhost:${PORT}/test-db`);
  console.log(`   GET  http://localhost:${PORT}/db-info`);
  console.log('='.repeat(60));
});