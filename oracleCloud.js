const oracledb = require('oracledb');
const path = require('path');

async function getConnection() {
  try {
    const walletPath = path.resolve(__dirname, './Wallet_DCSAAUJ'); // أو ../Wallet_DCSAAUJ حسب موقع الملف

    const connection = await oracledb.getConnection({
      user: "ADMIN",  // غيّرها إذا عندك مستخدم آخر
      password: "YOUR_ORACLE_PASSWORD",  // كلمة المرور لحسابك في قاعدة Oracle Cloud
      connectString: "dcsaauj_high",  // من tnsnames.ora
      walletLocation: walletPath
    });

    console.log("✅ Connected to Oracle Cloud Database!");
    return connection;
  } catch (err) {
    console.error("❌ Oracle Cloud Connection Error:", err);
    throw err;
  }
}

module.exports = getConnection;
