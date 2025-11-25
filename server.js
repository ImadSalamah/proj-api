// ================================
//  Imports & Setup
// ================================
const path = require("path");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const cors = require("cors");
const helmet = require("helmet");
const bcrypt = require("bcrypt");
const multer = require("multer");
const express = require("express");
const XLSX = require("xlsx");
const compression = require("compression");
const oracledb = require("oracledb");
const apicache = require("apicache");
const { v4: uuidv4 } = require("uuid");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const cache = apicache.middleware;

// ================================
//  Oracle Instant Client
// ================================
const oracleClientLib = process.env.ORACLE_CLIENT_LIB;
if (!oracleClientLib) {
  console.warn("⚠️ ORACLE_CLIENT_LIB not set; using system default client");
} else {
  try {
    oracledb.initOracleClient({ libDir: oracleClientLib });
  } catch (err) {
    console.error("❌ Failed to initialize Oracle client. Set ORACLE_CLIENT_LIB to a valid path.", err);
  }
}

// ================================
//  Oracle Connection Pool (Fixed)
// ================================
// Improve default handling of large CLOBs and fetch batch size for better throughput
oracledb.fetchAsString = [oracledb.CLOB];
oracledb.fetchArraySize = Number(process.env.DB_FETCH_ARRAY_SIZE || 100);

const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  connectString: process.env.DB_CONNECTION_STRING
};

async function initOraclePool() {
  try {
    // Reuse existing pool if server restarted without process exit
    const existing = oracledb.getPool();
    if (existing) {
      console.log("ℹ️ Oracle Pool already exists, reusing");
      return existing;
    }
  } catch (poolErr) {
    // getPool throws if none exists; ignore and create a new one below
  }

  try {
    await oracledb.createPool({
      ...dbConfig,
      poolMin: 5,
      poolMax: 20,
      poolIncrement: 1,
      queueTimeout: Number(process.env.DB_QUEUE_TIMEOUT || 5000),
      poolTimeout: Number(process.env.DB_POOL_TIMEOUT || 60)
    });
    console.log("✔ Oracle Pool Started");
  } catch (error) {
    console.error("❌ Oracle Pool Error:", error);
    // Bubble up so server won't start and routes won't crash with NJS-047
    throw error;
  }
}

async function getConnection() {
  return await oracledb.getConnection();
}





// ================================
//  Global Middlewares
// ================================
app.use(helmet());
app.use(compression());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Rate-limit
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 100
  })
);

// CORS (كما طلبت)
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    // ⚠️ Dev mode: allow all origins; set ALLOWED_ORIGINS for prod
    origin: "*"
  })
);

// ================================
//  Multer (ONE CLEAN INSTANCE ONLY)
// ================================
const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "text/csv"
    ];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error("Invalid file type. Only Excel/CSV files are allowed."));
  }
});

// ================================
//  JWT Auth Middleware
// ================================
function auth(req, res, next) {
  const header = req.headers.authorization;

  if (!header) {
    return res.status(401).json({ message: "Access denied, token missing" });
  }

  const token = header.split(" ")[1];

  if (!process.env.JWT_SECRET) {
    console.error("❌ Missing JWT_SECRET");
    return res.status(500).json({ message: "Server configuration error" });
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    return res.status(403).json({ message: "Invalid or expired token" });
  }
}

// ================================
//  Admin Middleware
// ================================
function isAdmin(req, res, next) {
  if (req.user?.role === "admin") return next();
  return res.status(403).json({ message: "Access denied, admin only" });
}

// ================================
// Helper Utils
// ================================
function cleanNotesField(notes) {
  if (!notes) return "";
  if (typeof notes === "string") {
    return notes
      .replace(/[^\w\s\u0600-\u06FF.,!?\-@#$%^&*()_+=]/g, "")
      .substring(0, 1000);
  }
  return String(notes).substring(0, 1000);
}

async function extractClobText(clobData) {
  if (!clobData) return null;
  try {
    if (typeof clobData === "string") return clobData;
    if (clobData?.toString) return clobData.toString();
    return null;
  } catch {
    return null;
  }
}

function parseDoubleEncodedJSON(jsonString) {
  if (!jsonString || typeof jsonString !== "string") return {};
  try {
    const cleaned = jsonString.trim();

    if (cleaned.startsWith("{") && cleaned.endsWith("}"))
      return JSON.parse(cleaned);

    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}") + 1;

    if (start !== -1 && end !== -1)
      return JSON.parse(cleaned.substring(start, end));

    return {};
  } catch {
    return {};
  }
}


// Pagination helper without تغيير السلوك الافتراضي
function getPagination(req, defaultLimit = 0, maxLimit = 200) {
  const limit = parseInt(req.query.limit, 10);
  const page = parseInt(req.query.page, 10);

  const safeLimit = !isNaN(limit) && limit > 0
    ? Math.min(limit, maxLimit)
    : defaultLimit;

  const offset = safeLimit > 0 && !isNaN(page) && page > 1
    ? (page - 1) * safeLimit
    : 0;

  return { limit: safeLimit, offset };
}

function buildPaginationClause(limit, offset) {
  if (!limit || limit <= 0) {
    return { clause: "", binds: {} };
  }
  return {
    clause: " OFFSET :offset ROWS FETCH NEXT :limit ROWS ONLY",
    binds: { offset: offset || 0, limit }
  };
}

function extractStudyYear(value) {
  if (value === undefined || value === null) return null;

  const candidates = Array.isArray(value)
    ? value
    : typeof value === "object"
      ? [
          value.STUDY_YEAR,
          value.studyYear,
          value.STUDENT_YEAR,
          value.study_year,
          value.STUDYYEAR,
          value.year,
          value.YEAR,
        ]
      : [value];

  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === "") continue;
    const parsed = Number(candidate);
    if (!Number.isNaN(parsed)) {
      return Number.isInteger(parsed) ? parsed : Math.trunc(parsed);
    }
  }

  return null;
}

// ================================
// جاهز – هون بتحط باقي الــ Routes
// ================================

// Require JWT for all routes except login (and allow CORS preflight)
const PUBLIC_ROUTES = new Set(["/login"]);
app.use((req, res, next) => {
  if (req.method === "OPTIONS") return next();
  if (PUBLIC_ROUTES.has(req.path)) return next();
  return auth(req, res, next);
});

const uploadExcel = upload;

app.post("/import-dental-students", auth, uploadExcel.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "❌ Please upload an Excel file." });
  }

  let connection;

  try {
    const workbook = XLSX.readFile(req.file.path);
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(worksheet);

    connection = await getConnection();  // 👈 تعديل فقط

    let successCount = 0;
    let failCount = 0;

    for (const row of rows) {
      try {
        const USER_ID = row.USER_ID || row.STUDENT_ID;
        const FIRST_NAME = row.FIRST_NAME || "";
        const FATHER_NAME = row.FATHER_NAME || "";
        const GRANDFATHER_NAME = row.GRANDFATHER_NAME || "";
        const FAMILY_NAME = row.FAMILY_NAME || "";
        const FULL_NAME =
          row.FULL_NAME ||
          `${FIRST_NAME} ${FATHER_NAME} ${GRANDFATHER_NAME} ${FAMILY_NAME}`.trim();

        const EMAIL = row.EMAIL || `${row.STUDENT_ID}@student.aaup.edu`;
        const USERNAME = row.USERNAME || row.STUDENT_ID;
        const ROLE = "dental_student";
        const studyYear = extractStudyYear(row);
        const studentUniversityId =
          row.STUDENT_ID ||
          row.STUDENT_UNIVERSITY_ID ||
          row.studentUniversityId ||
          row.student_id;

        let plainPassword;

        if (row.password) {
          plainPassword = row.password;

        } else if (row.PASSWORD_HASH) {
          plainPassword = row.PASSWORD_HASH;

        } else {
          plainPassword =
            `${FIRST_NAME.slice(0, 3)}${String(row.STUDENT_ID).slice(-4)}`.toLowerCase();
        }

        const PASSWORD_HASH = await bcrypt.hash(plainPassword, 10);

        await connection.execute(
          `
          INSERT INTO USERS (
            USER_ID, FULL_NAME, CREATED_AT, EMAIL, IS_ACTIVE,
            ROLE, USERNAME, PASSWORD_HASH, IS_DEAN
          ) VALUES (
            :USER_ID, :FULL_NAME, SYSDATE, :EMAIL, 1,
            :ROLE, :USERNAME, :PASSWORD_HASH, :IS_DEAN
          )
        `,
          {
            USER_ID,
            FULL_NAME: FULL_NAME || String(USER_ID),
            EMAIL,
            ROLE,
            USERNAME,
            PASSWORD_HASH,
            IS_DEAN: row.IS_DEAN ? Number(row.IS_DEAN) : 0
          }
        );

        if (studentUniversityId) {
          const studentColumns = ["USER_ID", "STUDENT_UNIVERSITY_ID"];
          const studentValues = [":USER_ID", ":STUDENT_UNIVERSITY_ID"];
          const studentBinds = {
            USER_ID,
            STUDENT_UNIVERSITY_ID: studentUniversityId,
          };

          if (studyYear !== null) {
            studentColumns.push("STUDY_YEAR");
            studentValues.push(":STUDY_YEAR");
            studentBinds.STUDY_YEAR = studyYear;
          }

          await connection.execute(
            `
            INSERT INTO STUDENTS (
              ${studentColumns.join(", ")}
            ) VALUES (
              ${studentValues.join(", ")}
            )
          `,
            studentBinds
          );
        }

        successCount++;
      } catch (e) {
        failCount++;
        console.error("❌ Row insert error:", e);
      }
    }

    await connection.commit();

    res.json({
      message: "📥 Import completed",
      inserted: successCount,
      failed: failCount,
      total: rows.length,
    });

  } catch (error) {
    if (connection) await connection.rollback();
    console.error("❌ Import error:", error);
    res.status(500).json({ message: "Server error", error: error.message });

  } finally {
    if (connection) await connection.close();
    try {
      const fs = require("fs");
      if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    } catch {}
  }
});

// ================================
// Import Users from Excel (Complete Version)
// ================================
app.post("/import-users", auth, upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "❌ Please upload an Excel file." });
  }

  let connection;

  try {
    // قراءة ملف Excel
    const workbook = XLSX.readFile(req.file.path);
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(worksheet);

    connection = await getConnection();

    let successCount = 0;
    let failCount = 0;
    const results = [];
    let userCounter = 1;

    for (const [index, row] of rows.entries()) {
      try {
        // التحقق من الحقول المطلوبة
        if (!row.USERNAME || row.USERNAME.toString().trim() === '') {
          throw new Error("USERNAME is required");
        }
        if (!row.EMAIL || row.EMAIL.toString().trim() === '') {
          throw new Error("EMAIL is required");
        }
        if (!row.FULL_NAME || row.FULL_NAME.toString().trim() === '') {
          throw new Error("FULL_NAME is required");
        }

        // إنشاء USER_ID إذا غير موجود
        let USER_ID;
        if (row.USER_ID && row.USER_ID.toString().trim() !== '') {
          USER_ID = row.USER_ID.toString().trim();
        } else {
          const rolePrefix = getRolePrefix(row.ROLE || row.role);
          const timestamp = Date.now().toString().slice(-6);
          USER_ID = `${rolePrefix}${timestamp}_${userCounter}`;
          userCounter++;
        }

        const FULL_NAME = row.FULL_NAME.toString().trim();
        const EMAIL = row.EMAIL.toString().trim();
        const USERNAME = row.USERNAME.toString().trim();
        const ROLE = row.ROLE || row.role || "user";

        const IS_ACTIVE = row.IS_ACTIVE !== undefined ? Number(row.IS_ACTIVE) : 1;
        const IS_DEAN = row.IS_DEAN ? Number(row.IS_DEAN) : 0;

        // =============================
        // NO AUTO PASSWORD GENERATION
        // =============================
        let plainPassword;

        if (row.password) {
          plainPassword = row.password.toString().trim();
        } else if (row.PASSWORD) {
          plainPassword = row.PASSWORD.toString().trim();
        } else {
          throw new Error("PASSWORD is required in Excel file and cannot be auto-generated.");
        }

        const PASSWORD_HASH = await bcrypt.hash(plainPassword, 10);

        // التحقق من عدم تكرار USERNAME
        const existingUsername = await connection.execute(
          `SELECT COUNT(*) as count FROM USERS WHERE USERNAME = :USERNAME`,
          { USERNAME },
          { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        if (existingUsername.rows[0].COUNT > 0) {
          results.push({ row: index + 1, username: USERNAME, status: 'skipped', reason: 'USERNAME already exists' });
          continue;
        }

        // التحقق من عدم تكرار EMAIL
        const existingEmail = await connection.execute(
          `SELECT COUNT(*) as count FROM USERS WHERE EMAIL = :EMAIL`,
          { EMAIL },
          { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        if (existingEmail.rows[0].COUNT > 0) {
          results.push({ row: index + 1, username: USERNAME, status: 'skipped', reason: 'EMAIL already exists' });
          continue;
        }

        // التحقق من عدم تكرار USER_ID
        const existingUser = await connection.execute(
          `SELECT COUNT(*) as count FROM USERS WHERE USER_ID = :USER_ID`,
          { USER_ID },
          { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        if (existingUser.rows[0].COUNT > 0) {
          results.push({ row: index + 1, username: USERNAME, status: 'skipped', reason: 'USER_ID already exists' });
          continue;
        }

        // إدخال المستخدم
        await connection.execute(
          `INSERT INTO USERS (
            USER_ID, FULL_NAME, CREATED_AT, EMAIL, IS_ACTIVE, ROLE, USERNAME, PASSWORD_HASH, IS_DEAN
          ) VALUES (
            :USER_ID, :FULL_NAME, SYSDATE, :EMAIL, :IS_ACTIVE, :ROLE, :USERNAME, :PASSWORD_HASH, :IS_DEAN
          )`,
          {
            USER_ID,
            FULL_NAME,
            EMAIL,
            IS_ACTIVE,
            ROLE,
            USERNAME,
            PASSWORD_HASH,
            IS_DEAN
          },
          { autoCommit: false }
        );

        // إذا كان طالب
        if (ROLE.includes('student') || ROLE.includes('طالب')) {
          const studentUniId =
            row.STUDENT_UNIVERSITY_ID ||
            row.student_university_id ||
            row.university_id;

          if (!studentUniId) {
            throw new Error("STUDENT_UNIVERSITY_ID is required for student");
          }

          const studyYear = extractStudyYear(row);

          await connection.execute(
            `INSERT INTO STUDENTS (USER_ID, STUDENT_UNIVERSITY_ID, STUDY_YEAR)
             VALUES (:USER_ID, :STUDENT_UNIVERSITY_ID, :STUDY_YEAR)`,
            {
              USER_ID,
              STUDENT_UNIVERSITY_ID: studentUniId.toString(),
              STUDY_YEAR: studyYear
            },
            { autoCommit: false }
          );
        }

        // إذا كان طبيب
        if (ROLE.includes('doctor') || ROLE.includes('طبيب')) {
          let ALLOWED_FEATURES = row.ALLOWED_FEATURES || "[]";

          await connection.execute(
            `INSERT INTO DOCTORS (
              DOCTOR_ID, ALLOWED_FEATURES, DOCTOR_TYPE, IS_ACTIVE, CREATED_AT
            ) VALUES (
              :DOCTOR_ID, :ALLOWED_FEATURES, :DOCTOR_TYPE, 1, SYSTIMESTAMP
            )`,
            {
              DOCTOR_ID: USER_ID,
              ALLOWED_FEATURES,
              DOCTOR_TYPE: row.DOCTOR_TYPE || 'طبيب عام'
            },
            { autoCommit: false }
          );
        }

        successCount++;
        results.push({
          row: index + 1,
          user_id: USER_ID,
          username: USERNAME,
          email: EMAIL,
          role: ROLE,
          status: "success"
        });

      } catch (err) {
        failCount++;
        results.push({
          row: index + 1,
          username: row.USERNAME || 'Unknown',
          status: "failed",
          error: err.message
        });
      }
    }

    await connection.commit();

    res.json({
      message: "📥 Import completed successfully",
      summary: {
        total: rows.length,
        inserted: successCount,
        failed: failCount,
      },
      details: results
    });

  } catch (error) {
    if (connection) await connection.rollback();
    res.status(500).json({ message: "Server error during import", error: error.message });

  } finally {
    if (connection) await connection.close();
    try {
      const fs = require('fs');
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    } catch {}
  }
});



function getRolePrefix(role) {
  if (!role) return 'USER_';
  
  const roleMap = {
    'doctor': 'DOC_',
    'طبيب': 'DOC_',
    'nurse': 'NUR_',
    'ممرض': 'NUR_',
    'admin': 'ADM_',
    'مدير': 'ADM_',
    'student': 'STU_',
    'طالب': 'STU_',
    'dental_student': 'STU_',
    'secretary': 'SEC_',
    'سكرتير': 'SEC_',
    'radiology': 'RAD_',
    'فني أشعة': 'RAD_'
  };
  
  const lowerRole = role.toLowerCase();
  for (const [key, prefix] of Object.entries(roleMap)) {
    if (lowerRole.includes(key)) {
      return prefix;
    }
  }
  
  return 'USER_';
}


app.get('/test-db', async (req, res) => {
  try {
    const conn = await getConnection();  // 👈 تعديل فقط
    const result = await conn.execute(`SELECT USERNAME, ROLE FROM USERS`);
    await conn.close();
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send('Database connection error');
  }
});


// 1. Save examination data
app.post("/examinations", auth, async (req, res) => {
  const {
    exam_id,
    patient_uid,
    doctor_id,
    exam_data,
    screening_data,
    dental_form_data,
    notes
  } = req.body;

  if (!exam_id || !patient_uid || !doctor_id) {
    return res.status(400).json({
      message: "❌ Missing required fields",
      required: ['exam_id', 'patient_uid', 'doctor_id']
    });
  }

  let connection;
  try {
    connection = await getConnection(); // 👈 تعديل فقط

    const patientCheck = await connection.execute(
      `SELECT COUNT(*) as count FROM patients WHERE patient_uid = :patient_uid`,
      { patient_uid },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (patientCheck.rows[0].COUNT === 0) {
      return res.status(404).json({
        message: "❌ Patient not found",
        patient_uid
      });
    }

    const bindValues = {
      exam_id,
      patient_uid,
      doctor_id,
      exam_data: exam_data ?? null,
      screening_data: screening_data ?? null,
      dental_form_data: dental_form_data ?? null,
      notes: notes ?? null
    };

    // Upsert to avoid duplicate exam_id errors (ORA-00001)
    const existsResult = await connection.execute(
      `SELECT COUNT(*) AS COUNT FROM examinations WHERE exam_id = :exam_id`,
      { exam_id },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const isUpdate = existsResult.rows[0].COUNT > 0;

    const sql = isUpdate
      ? `
        UPDATE examinations
        SET
          patient_uid = :patient_uid,
          doctor_id = :doctor_id,
          exam_date = SYSTIMESTAMP,
          exam_data = to_clob(:exam_data),
          screening_data = to_clob(:screening_data),
          dental_form_data = to_clob(:dental_form_data),
          notes = to_clob(:notes)
        WHERE exam_id = :exam_id
      `
      : `
        INSERT INTO examinations (
          exam_id, patient_uid, doctor_id, exam_date,
          exam_data, screening_data, dental_form_data, notes
        ) VALUES (
          :exam_id, :patient_uid, :doctor_id, SYSTIMESTAMP,
          to_clob(:exam_data),
          to_clob(:screening_data),
          to_clob(:dental_form_data),
          to_clob(:notes)
        )
      `;

    const result = await connection.execute(sql, bindValues, { autoCommit: true });

    res.status(isUpdate ? 200 : 201).json({
      message: isUpdate ? "✅ Examination updated successfully" : "✅ Examination saved successfully",
      exam_id,
      rowsAffected: result.rowsAffected
    });

  } catch (err) {
    console.error("❌ Error saving examination:", err);

    let errorMessage = "❌ Error saving examination";
    if (err.errorNum === 1) {
      errorMessage = "❌ Examination ID already exists";
    } else if (err.errorNum === 2291) {
      errorMessage = "❌ Patient not found in database";
    }

    res.status(500).json({
      message: errorMessage,
      error: err.message,
      errorCode: err.errorNum
    });
  } finally {
    if (connection) await connection.close();
  }
});


// 2. Save screening data
app.post("/screening", async (req, res) => {
  const {
    patient_uid,
    screening_data,
    timestamp
  } = req.body;

  if (!patient_uid || !screening_data) {
    return res.status(400).json({ 
      message: "❌ Missing required fields",
      required: ['patient_uid', 'screening_data']
    });
  }

  let connection;
  try {
    connection = await getConnection(); // 👈 تعديل فقط

    const patientCheck = await connection.execute(
      `SELECT COUNT(*) as count FROM patients WHERE patient_uid = :patient_uid`,
      { patient_uid },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (patientCheck.rows[0].COUNT === 0) {
      return res.status(404).json({ 
        message: "❌ Patient not found",
        patient_uid 
      });
    }

    const sql = `
      INSERT INTO screening_data (
        screening_id, patient_uid, screening_data, created_at
      ) VALUES (
        :screening_id, :patient_uid, :screening_data, SYSTIMESTAMP
      )
    `;

    const bindValues = {
      screening_id: `SCR_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      patient_uid,
      screening_data: JSON.stringify(screening_data)
    };

    const result = await connection.execute(sql, bindValues, { autoCommit: true });

    res.status(201).json({ 
      message: "✅ Screening data saved successfully",
      rowsAffected: result.rowsAffected
    });

  } catch (err) {
    console.error("❌ Error saving screening data:", err);
    
    res.status(500).json({ 
      message: "❌ Error saving screening data", 
      error: err.message 
    });
  } finally {
    if (connection) await connection.close();
  }
});


app.get('/doctors/simple/:id', async (req, res) => {
  let connection;
  try {
    const { id } = req.params;
    connection = await getConnection(); // 👈 تعديل فقط
    
    const result = await connection.execute(
      `SELECT DOCTOR_ID, ALLOWED_FEATURES, DOCTOR_TYPE, IS_ACTIVE 
       FROM doctors 
       WHERE DOCTOR_ID = :id`,
      [id],
      { 
        outFormat: oracledb.OUT_FORMAT_OBJECT,
        fetchInfo: {
          "ALLOWED_FEATURES": { type: oracledb.STRING }
        }
      }
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Doctor not found' });
    }
    
    const doctor = result.rows[0];
    
    let allowedFeatures = [];
    if (doctor.ALLOWED_FEATURES) {
      try {
        const featuresString = typeof doctor.ALLOWED_FEATURES === 'object' 
          ? await doctor.ALLOWED_FEATURES.getData() 
          : doctor.ALLOWED_FEATURES.toString();
        
        if (featuresString && featuresString.trim() !== '') {
          allowedFeatures = JSON.parse(featuresString);
        }
      } catch (e) {
        console.error('❌ Error parsing ALLOWED_FEATURES:', e);
        allowedFeatures = [];
      }
    }
    
    const responseData = {
      message: '✅ Doctor data retrieved successfully',
      doctor: {
        DOCTOR_ID: doctor.DOCTOR_ID,
        ALLOWED_FEATURES: allowedFeatures,
        DOCTOR_TYPE: doctor.DOCTOR_TYPE,
        IS_ACTIVE: doctor.IS_ACTIVE
      }
    };
    
    res.json(responseData);
    
  } catch (error) {
    console.error('❌ Error fetching doctor:', error);
    res.status(500).json({ 
      message: '❌ Error fetching doctor',
      error: error.message 
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err);
      }
    }
  }
});


// 3. Get all students
app.get("/students", async (req, res) => {
  let connection;
  try {
    connection = await getConnection();

    const result = await connection.execute(
      `SELECT 
        u.USER_ID as USER_ID,
        u.FULL_NAME as FULL_NAME,
        u.USERNAME as USERNAME,
        u.EMAIL as EMAIL,
        u.ROLE as ROLE,
        u.IS_ACTIVE as IS_ACTIVE,
        u.IS_DEAN as IS_DEAN,
        u.CREATED_AT as CREATED_AT,
        s.STUDENT_UNIVERSITY_ID as STUDENT_UNIVERSITY_ID,
        s.STUDY_YEAR as STUDY_YEAR
       FROM USERS u
       LEFT JOIN STUDENTS s ON u.USER_ID = s.USER_ID
       WHERE u.ROLE LIKE '%student%' OR u.ROLE LIKE '%طالب%'
       ORDER BY u.FULL_NAME`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const students = result.rows.map(student => {
      const fullName = student.FULL_NAME || "";
      const [firstName = ""] = fullName.split(" ");

      return {
        USER_ID: student.USER_ID,  // ← المفتاح الأساسي
        id: student.USER_ID,       // ← alias اختياري
        firstName,
        fatherName: "",
        grandfatherName: "",
        familyName: "",
        fullName,
        username: student.USERNAME || "",
        email: student.EMAIL || "",
        role: student.ROLE || "",
        isActive: student.IS_ACTIVE,
        isDean: student.IS_DEAN ?? 0,
        createdAt: student.CREATED_AT,
        universityId: student.STUDENT_UNIVERSITY_ID || "",
        STUDENT_UNIVERSITY_ID: student.STUDENT_UNIVERSITY_ID || "",
        studyYear: student.STUDY_YEAR ?? null
      };
    });

    res.status(200).json(students);

  } catch (err) {
    console.error("❌ Error fetching students:", err);
    res.status(500).json({
      message: "❌ Error fetching students",
      error: err.message
    });
  } finally {
    if (connection) await connection.close();
  }
});



// 4. Get all patients
app.get("/patients", cache("30 seconds"), async (req, res) => {
  let connection;
  try {
    connection = await getConnection(); // 👈 تعديل فقط

    const { limit, offset } = getPagination(req, 0, 500);
    const pagination = buildPaginationClause(limit, offset);

    const result = await connection.execute(
      `SELECT 
        PATIENT_UID as id,
        FIRSTNAME as firstName,
        FATHERNAME as fatherName,
        GRANDFATHERNAME as grandfatherName,
        FAMILYNAME as familyName,
        IDNUMBER as idNumber,
        GENDER as gender,
        PHONE as phone,
        MEDICAL_RECORD_NO as medicalRecordNo,
        STATUS as status
       FROM PATIENTS 
       WHERE STATUS = 'active' OR STATUS IS NULL OR STATUS = 'EXAMINED'
       ORDER BY FIRSTNAME, FAMILYNAME${pagination.clause}`,
      { ...pagination.binds },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    res.status(200).json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching patients:", err);
    res.status(500).json({ 
      message: "❌ Error fetching patients", 
      error: err.message 
    });
  } finally {
    if (connection) await connection.close();
  }
});


// 5. Get assigned patients for a student
app.get("/student_assignments/:studentId", async (req, res) => {
  const { studentId } = req.params;
  let connection;
  try {
    connection = await getConnection(); // 👈 تعديل فقط

    const result = await connection.execute(
      `SELECT 
        sa.assignment_id,
        sa.patient_uid,
        sa.assigned_date,
        sa.status,
        p.FIRSTNAME,
        p.FATHERNAME,
        p.GRANDFATHERNAME,
        p.FAMILYNAME,
        p.IDNUMBER,
        p.PHONE
       FROM student_assignments sa
       JOIN patients p ON sa.patient_uid = p.PATIENT_UID
       WHERE sa.student_id = :studentId
       AND sa.status = 'ACTIVE'
       ORDER BY sa.assigned_date DESC`,
      { studentId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    res.status(200).json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching student assignments:", err);
    res.status(500).json({ 
      message: "❌ Error fetching student assignments", 
      error: err.message 
    });
  } finally {
    if (connection) await connection.close();
  }
});


// 6. Save student assignments
app.post("/student_assignments", async (req, res) => {
  const {
    student_id,
    patient_uids
  } = req.body;

  if (!student_id || !patient_uids || !Array.isArray(patient_uids)) {
    return res.status(400).json({ 
      message: "❌ Missing required fields",
      required: ['student_id', 'patient_uids (array)']
    });
  }

  let connection;
  try {
    connection = await getConnection(); // 👈 تعديل فقط

    const studentCheck = await connection.execute(
      `SELECT COUNT(*) as count FROM users WHERE user_id = :student_id`,
      { student_id },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (studentCheck.rows[0].COUNT === 0) {
      return res.status(404).json({ 
        message: "❌ Student not found",
        student_id 
      });
    }

    let successCount = 0;
    let errorCount = 0;
    const results = [];

    for (const patient_uid of patient_uids) {
      try {
        const patientCheck = await connection.execute(
          `SELECT COUNT(*) as count FROM patients WHERE patient_uid = :patient_uid`,
          { patient_uid },
          { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );

        if (patientCheck.rows[0].COUNT === 0) {
          results.push({ patient_uid, status: 'error', message: 'Patient not found' });
          errorCount++;
          continue;
        }

        const existingAssignment = await connection.execute(
          `SELECT COUNT(*) as count FROM student_assignments 
           WHERE student_id = :student_id AND patient_uid = :patient_uid AND status = 'ACTIVE'`,
          { student_id, patient_uid },
          { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );

        if (existingAssignment.rows[0].COUNT > 0) {
          results.push({ patient_uid, status: 'skipped', message: 'Already assigned' });
          continue;
        }

        const sql = `
          INSERT INTO student_assignments (
            assignment_id, student_id, patient_uid, assigned_date, status
          ) VALUES (
            :assignment_id, :student_id, :patient_uid, SYSTIMESTAMP, 'ACTIVE'
          )
        `;

        const bindValues = {
          assignment_id: `ASSIGN_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          student_id,
          patient_uid
        };

        await connection.execute(sql, bindValues, { autoCommit: false });
        results.push({ patient_uid, status: 'success' });
        successCount++;

      } catch (err) {
        console.error(`❌ Error assigning patient ${patient_uid}:`, err);
        results.push({ patient_uid, status: 'error', message: err.message });
        errorCount++;
      }
    }

    await connection.commit();


    res.status(201).json({ 
      message: `✅ تم حفظ التعيينات بنجاح: ${successCount} نجح, ${errorCount} فشل`,
      successCount,
      errorCount,
      details: results
    });

  } catch (err) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackErr) {
        console.error("❌ Rollback error:", rollbackErr);
      }
    }
    console.error("❌ Error saving student assignments:", err);
    res.status(500).json({ 
      message: "❌ Error saving student assignments", 
      error: err.message 
    });
  } finally {
    if (connection) await connection.close();
  }
});


// 7. Update patient status
app.put("/patients/:patientId/status", async (req, res) => {
  const { patientId } = req.params;
  const { status } = req.body;

  if (!status) {
    return res.status(400).json({ message: "❌ Status is required" });
  }

  let connection;
  try {
    connection = await getConnection(); // 👈 تعديل فقط

    const result = await connection.execute(
      `UPDATE PATIENTS SET STATUS = :status WHERE PATIENT_UID = :patientId`,
      { status, patientId },
      { autoCommit: true }
    );

    if (result.rowsAffected === 0) {
      return res.status(404).json({ message: "❌ Patient not found" });
    }

    res.status(200).json({ 
      message: "✅ Patient status updated successfully",
      patientId,
      newStatus: status
    });
  } catch (err) {
    console.error("❌ Error updating patient status:", err);
    res.status(500).json({ 
      message: "❌ Error updating patient status", 
      error: err.message 
    });
  } finally {
    if (connection) await connection.close();
  }
});



// 8. Update appointment examined status
app.put("/appointments/update_examined/:patientId", async (req, res) => {
  const { patientId } = req.params;
  const { examined } = req.body;

  let connection;
  try {
    connection = await getConnection(); // FIXED

    const result = await connection.execute(
      `UPDATE APPOINTMENTS SET EXAMINED = :examined WHERE PATIENT_ID_NUMBER = :patientId`,
      { examined: examined ? 1 : 0, patientId },
      { autoCommit: true }
    );

    if (result.rowsAffected === 0) {
      return res.status(404).json({ message: "❌ Appointment not found" });
    }

    res.status(200).json({
      message: "✅ Appointment status updated successfully",
      patientId,
      examined
    });
  } catch (err) {
    console.error("❌ Error updating appointment status:", err);
    res.status(500).json({
      message: "❌ Error updating appointment status",
      error: err.message
    });
  } finally {
    if (connection) await connection.close();
  }
});


// 9. Check if patient exists
app.get("/check-patient/:patientUid", async (req, res) => {
  const { patientUid } = req.params;
  let connection;

  try {
    connection = await getConnection(); // FIXED

    const result = await connection.execute(
      `SELECT PATIENT_UID, FIRSTNAME, FAMILYNAME 
       FROM PATIENTS 
       WHERE PATIENT_UID = :patientUid`,
      { patientUid },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        exists: false,
        message: "❌ Patient not found"
      });
    }

    res.json({
      exists: true,
      patient: result.rows[0]
    });

  } catch (err) {
    console.error("❌", err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});


// 10. Check doctor data
app.get("/check-doctor/:id", async (req, res) => {
  const { id } = req.params;
  let connection;

  try {
    connection = await getConnection(); // FIXED

    const userResult = await connection.execute(
      `SELECT USER_ID, FULL_NAME, ROLE 
       FROM USERS 
       WHERE USER_ID = :id`,
      { id },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const doctorResult = await connection.execute(
      `SELECT d.DOCTOR_ID, d.DOCTOR_TYPE, 
              DBMS_LOB.SUBSTR(d.ALLOWED_FEATURES, 32000, 1) as FEATURES
       FROM DOCTORS d
       WHERE d.DOCTOR_ID = :id`,
      { id },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    res.json({
      userExists: userResult.rows.length > 0,
      doctorExists: doctorResult.rows.length > 0,
      user: userResult.rows[0] || null,
      doctor: doctorResult.rows[0] || null,
      features: doctorResult.rows[0]?.FEATURES || null
    });

  } catch (err) {
    console.error("❌", err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});


// 11. Find patient by appointment ID
app.get("/patients/by-appointment-id/:idnumber", async (req, res) => {
  const { idnumber } = req.params;
  let connection;

  try {
    connection = await getConnection(); // FIXED

    const result = await connection.execute(
      `SELECT * FROM PATIENTS WHERE IDNUMBER = :idnumber`,
      { idnumber }, // NO PARSEINT FIXED
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (!result.rows.length) {
      return res.status(404).json({
        message: "❌ Patient not found",
        idnumber
      });
    }

    res.json(result.rows[0]);

  } catch (err) {
    console.error("❌ Error fetching patient:", err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});


// 12. Get all pending users
app.get("/pendingUsers", auth, async (req, res) => {
  let connection;
  try {
    connection = await getConnection(); // FIXED

    const result = await connection.execute(
      `SELECT * FROM PENDINGUSERS 
       WHERE STATUS = 'pending' OR STATUS IS NULL`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const users = result.rows.map(u => ({
      ...u,
      FIRSTNAME: u.FIRSTNAME || "Unknown",
      IDIMAGE: u.IDIMAGE || null
    }));

    res.json(users);

  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});


// 13. Add new pending user
app.post("/pendingUsers", auth, async (req, res) => {
  let connection;

  let parsedBody = typeof req.body === "string"
    ? JSON.parse(req.body)
    : req.body;

  try {
    connection = await getConnection(); // FIXED

    const birthDateValue = parsedBody.birthDate
      ? new Date(parsedBody.birthDate).toISOString().slice(0, 10)
      : '2000-01-01';

    const bindValues = [
      parsedBody.uid || parsedBody.authUid || "user_" + Date.now(),
      parsedBody.firstName || "",
      parsedBody.fatherName || "",
      parsedBody.grandfatherName || "",
      parsedBody.familyName || "",
      parsedBody.idNumber || 0,
      birthDateValue,
      parsedBody.gender || "",
      parsedBody.address || "",
      parsedBody.phone || "",
      parsedBody.idImage || "",
      "pending",
      "patient",
      0,
      parsedBody.studentId || "unknown"
    ];

    const sql = `
      INSERT INTO PENDINGUSERS (
        USER_UID, FIRSTNAME, FATHERNAME, GRANDFATHERNAME, FAMILYNAME,
        IDNUMBER, BIRTHDATE, GENDER, ADDRESS, PHONE, IDIMAGE,
        STATUS, ROLE, ISACTIVE, STUDENTID, CREATEDAT
      ) VALUES (
        :1, :2, :3, :4, :5, :6, TO_DATE(:7,'YYYY-MM-DD'),
        :8,:9,:10,:11,:12,:13,:14,:15,SYSDATE
      )
    `;

    const result = await connection.execute(sql, bindValues, { autoCommit: true });

    res.json({
      message: "✅ Pending user added",
      rowsAffected: result.rowsAffected
    });

  } catch (err) {
    console.error("❌", err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});


// 14. Update IQRAR
app.put("/pendingUsers/:userId", auth, async (req, res) => {
  const { userId } = req.params;
  const { IQRAR } = req.body;

  if (!IQRAR) return res.status(400).json({ message: "❌ IQRAR is required" });

  let connection;
  try {
    connection = await getConnection(); // FIXED

    const sql = `UPDATE PENDINGUSERS SET IQRAR = :iqrar WHERE USER_UID = :userId`;

    const result = await connection.execute(sql, { iqrar: IQRAR, userId }, { autoCommit: true });

    if (result.rowsAffected === 0) {
      return res.status(404).json({ message: "❌ User not found" });
    }

    res.json({ message: "✅ IQRAR updated successfully" });

  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});


// 15. Approve user
app.post("/approveUser", auth, async (req, res) => {
  let connection;
  try {
    connection = await getConnection(); // FIXED
    
    const userData = req.body;

    if (!userData.IDNUMBER) {
      return res.status(400).json({ message: "❌ IDNUMBER is required" });
    }

    const patientUid = String(userData.IDNUMBER);
    const medicalRecordNo = "MR" + String(Date.now()).slice(-6);

    const clean = {
      FIRSTNAME: (userData.FIRSTNAME || "Unknown").trim(),
      FATHERNAME: userData.FATHERNAME || "",
      GRANDFATHERNAME: userData.GRANDFATHERNAME || "",
      FAMILYNAME: userData.FAMILYNAME || "",
      IDNUMBER: userData.IDNUMBER,
      GENDER:
        /^(male|ذكر)$/i.test(userData.GENDER) ? "MALE" :
        /^(female|أنثى)$/i.test(userData.GENDER) ? "FEMALE" : "MALE",
      ADDRESS: userData.ADDRESS || "",
      PHONE: (userData.PHONE || "").replace(/\D/g, ""),
      IQRAR: userData.IQRAR || null,
      IMAGE: userData.IMAGE || null,
      IDIMAGE: userData.IDIMAGE || null
    };

    const birthDateValue = userData.BIRTHDATE
      ? new Date(userData.BIRTHDATE).toISOString().slice(0, 10)
      : "2000-01-01";

    // Use positional binds to avoid ORA-01745 from malformed bind names
    const insertSql = `
      INSERT INTO PATIENTS (
        PATIENT_UID, FIRSTNAME, FATHERNAME, GRANDFATHERNAME, FAMILYNAME,
        IDNUMBER, BIRTHDATE, GENDER, ADDRESS, PHONE,
        STATUS, IQRAR, IMAGE, IDIMAGE, APPROVED_DATE, APPROVED_BY, MEDICAL_RECORD_NO
      ) VALUES (
        :1, :2, :3, :4, :5,
        :6, TO_DATE(:7,'YYYY-MM-DD'), :8, :9, :10,
        'active', :11, :12, :13, SYSDATE, 'system', :14
      )
    `;

    const insertBinds = [
      patientUid,
      clean.FIRSTNAME,
      clean.FATHERNAME,
      clean.GRANDFATHERNAME,
      clean.FAMILYNAME,
      clean.IDNUMBER,
      birthDateValue,
      clean.GENDER,
      clean.ADDRESS,
      clean.PHONE,
      clean.IQRAR,
      clean.IMAGE,
      clean.IDIMAGE,
      medicalRecordNo
    ];

    await connection.execute(insertSql, insertBinds, { autoCommit: false });

    await connection.execute(
      `DELETE FROM PENDINGUSERS WHERE USER_UID = :1`,
      [userData.USER_UID],
      { autoCommit: false }
    );

    await connection.commit();

    res.json({
      message: "✅ User approved",
      patientUid,
      medicalRecordNo
    });

  } catch (err) {
    if (connection) await connection.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});


// 16. Reject user
app.post("/rejectUser", auth, async (req, res) => {
  let connection;
  try {
    connection = await getConnection(); // FIXED

    const { USER_UID, REJECTIONREASON } = req.body;

    const result = await connection.execute(
      `
      UPDATE PENDINGUSERS
      SET STATUS = 'rejected',
          REJECTIONREASON = :1,
          REJECTEDAT = SYSDATE
      WHERE USER_UID = :2
      `,
      [
        REJECTIONREASON || "No reason provided",
        USER_UID
      ],
      { autoCommit: true }
    );

    if (result.rowsAffected === 0) {
      return res.status(404).json({ message: "❌ User not found" });
    }

    res.json({ message: "✅ User rejected" });

  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});


// 17. Update user
app.post("/updateUser", auth, async (req, res) => {
  let connection;
  try {
    connection = await getConnection(); // FIXED

    const { USER_UID, ...updatedData } = req.body;

    if (!USER_UID) {
      return res.status(400).json({ message: "❌ USER_UID is required" });
    }

    const setClause = [];
    const bindValues = { userId: USER_UID };

    for (const key of Object.keys(updatedData)) {
      const val = updatedData[key];

      if (val !== undefined && val !== null) {
        if (key === "BIRTHDATE") {
          const dateObj = new Date(val);
          if (isNaN(dateObj.getTime())) {
            return res.status(400).json({ message: "Invalid date format" });
          }
          const formatted = dateObj.toISOString().slice(0, 10);
          setClause.push(`${key} = TO_DATE(:${key}, 'YYYY-MM-DD')`);
          bindValues[key] = formatted;
        } else {
          setClause.push(`${key} = :${key}`);
          bindValues[key] = val;
        }
      }
    }

    if (!setClause.length) {
      return res.status(400).json({ message: "❌ No fields to update" });
    }

    const sql = `
      UPDATE PENDINGUSERS 
      SET ${setClause.join(", ")}
      WHERE USER_UID = :userId
    `;

    const result = await connection.execute(sql, bindValues, { autoCommit: true });

    if (result.rowsAffected === 0) {
      return res.status(404).json({ message: "❌ User not found" });
    }

    res.json({
      message: "✅ User updated",
      updated: Object.keys(updatedData)
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});


// 18. Get all rejected users
app.get("/rejectedUsers", auth, async (req, res) => {
  let connection;
  try {
    connection = await getConnection(); // FIXED

    const result = await connection.execute(
      `SELECT * FROM PENDINGUSERS WHERE STATUS = 'rejected'`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    res.json(result.rows);

  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});


// 19. Get student university ID (FIXED routing conflict)
app.get("/students/:userId", async (req, res) => {
  const { userId } = req.params;

  let connection;
  try {
    connection = await getConnection(); // FIXED

    const result = await connection.execute(
      `SELECT STUDENT_UNIVERSITY_ID, STUDY_YEAR 
       FROM STUDENTS 
       WHERE USER_ID = :userId`,
      { userId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (!result.rows.length) {
      return res.status(404).json({ message: "❌ Student not found" });
    }

    res.json({
      ...result.rows[0],
      studyYear: result.rows[0].STUDY_YEAR ?? null
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});



// ✅ Helper: توحيد قراءة الـ JSON Body
function parseJsonBody(req, res) {
  if (!req.body) return {};

  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch (e) {
      res.status(400).json({ message: "Invalid JSON body" });
      return null;
    }
  }

  return req.body;
}

// 20. 🔐 Get all users (Admins only) - IMPROVED
app.get("/users", auth, async (req, res) => {
  let connection;
  try {
    connection = await getConnection();

    let query = `
      SELECT 
        u.USER_ID,
        u.FULL_NAME,
        u.CREATED_AT,
        u.EMAIL,
        u.IS_ACTIVE,
        u.IS_DEAN,
        u.ROLE,
        u.USERNAME,
        s.STUDENT_UNIVERSITY_ID,
        s.STUDY_YEAR
      FROM USERS u
      LEFT JOIN STUDENTS s ON u.USER_ID = s.USER_ID
    `;
    const binds = {};

    if (req.query.username) {
      query += ` WHERE LOWER(u.USERNAME) = :username`;
      binds.username = req.query.username.toLowerCase();
    }

    const result = await connection.execute(query, binds, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
    });

    const users = (result.rows || []).map((row) => {
      const safeRow = {};
      Object.keys(row).forEach((key) => {
        safeRow[key] = row[key] ?? null;
      });
      return safeRow;
    });

    return res.status(200).json(users);
  } catch (err) {
    console.error("❌ Error fetching users:", err);
    return res
      .status(500)
      .json({ message: "❌ Error fetching users", error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

// 20.b Get single user (basic info) by USER_ID - protected by JWT
app.get("/users/:userId", auth, async (req, res) => {
  let connection;
  try {
    connection = await getConnection();

    const { userId } = req.params;
    const result = await connection.execute(
      `
        SELECT 
          u.USER_ID,
          u.FULL_NAME,
          u.EMAIL,
          u.ROLE,
          s.STUDENT_UNIVERSITY_ID,
          s.STUDY_YEAR
        FROM USERS u
        LEFT JOIN STUDENTS s ON u.USER_ID = s.USER_ID
        WHERE u.USER_ID = :userId
      `,
      { userId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (!result.rows || result.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const row = result.rows[0];
    const safeRow = {};
    Object.keys(row).forEach((key) => {
      safeRow[key] = row[key] ?? null;
    });

    return res.status(200).json(safeRow);
  } catch (err) {
    console.error("❌ Error fetching user by id:", err);
    return res
      .status(500)
      .json({ message: "❌ Error fetching user by id", error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

// 21. 🔐 Add new user (Admins only) - IMPROVED
app.post("/users", auth, async (req, res) => {
  const parsedBody = parseJsonBody(req, res);
  if (parsedBody === null) return; // تم الرد بخطأ JSON

  if (!parsedBody || Object.keys(parsedBody).length === 0) {
    return res
      .status(400)
      .json({ message: "Request body is empty or invalid" });
  }

  // التحقق من الحقول الأساسية
  if (!parsedBody.USER_ID && !parsedBody.STUDENT_ID) {
    return res
      .status(400)
      .json({ message: "USER_ID or STUDENT_ID is required" });
  }

  if (!parsedBody.USERNAME || !parsedBody.EMAIL) {
    return res.status(400).json({
      message: "USERNAME and EMAIL are required",
    });
  }

  let connection;
  try {
    connection = await getConnection();

    // ✅ Hash password دائمًا
    let passwordHash;
    if (parsedBody.password) {
      passwordHash = await bcrypt.hash(parsedBody.password, 10);
    } else if (parsedBody.PASSWORD) {
      passwordHash = await bcrypt.hash(parsedBody.PASSWORD, 10);
    } else if (parsedBody.PASSWORD_HASH) {
      // نفترض إنها already hashed
      passwordHash = parsedBody.PASSWORD_HASH;
    } else {
      // باسورد افتراضي لو مش مبعوث
      passwordHash = await bcrypt.hash("Default123!", 10);
    }

    const fullName =
      parsedBody.FULL_NAME ||
      [
        parsedBody.FIRST_NAME,
        parsedBody.FATHER_NAME,
        parsedBody.GRANDFATHER_NAME,
        parsedBody.FAMILY_NAME,
      ]
        .filter(Boolean)
        .join(" ")
        .trim();

    const userSql = `
      INSERT INTO USERS (
        USER_ID, FULL_NAME, CREATED_AT, EMAIL, IS_ACTIVE, ROLE,
        USERNAME, PASSWORD_HASH, IS_DEAN
      ) VALUES (
        :USER_ID, :FULL_NAME, SYSDATE, :EMAIL, :IS_ACTIVE, :ROLE,
        :USERNAME, :PASSWORD_HASH, :IS_DEAN
      )
    `;

    const userBindValues = {
      USER_ID: parsedBody.USER_ID || parsedBody.STUDENT_ID,
      FULL_NAME: fullName || String(parsedBody.USER_ID || parsedBody.STUDENT_ID || ""),
      EMAIL: parsedBody.EMAIL || "",
      IS_ACTIVE:
        parsedBody.IS_ACTIVE === 0 || parsedBody.IS_ACTIVE === "0" ? 0 : 1,
      ROLE: parsedBody.ROLE || "dental_student",
      USERNAME: parsedBody.USERNAME,
      PASSWORD_HASH: passwordHash,
      IS_DEAN: parsedBody.IS_DEAN ? Number(parsedBody.IS_DEAN) : 0
    };

    await connection.execute(userSql, userBindValues, { autoCommit: false });

    const studentUniversityId =
      parsedBody.STUDENT_UNIVERSITY_ID ||
      parsedBody.STUDENT_ID ||
      parsedBody.studentUniversityId ||
      parsedBody.universityId;
    const studyYearFromBody = extractStudyYear(parsedBody);

    let studentResult = null;
    if (studentUniversityId || studyYearFromBody !== null) {
      const studentSqlColumns = ["USER_ID"];
      const studentSqlValues = [":USER_ID"];
      const studentBindValues = { USER_ID: userBindValues.USER_ID };

      if (studentUniversityId) {
        studentSqlColumns.push("STUDENT_UNIVERSITY_ID");
        studentSqlValues.push(":STUDENT_UNIVERSITY_ID");
        studentBindValues.STUDENT_UNIVERSITY_ID = studentUniversityId;
      }

      if (studyYearFromBody !== null) {
        studentSqlColumns.push("STUDY_YEAR");
        studentSqlValues.push(":STUDY_YEAR");
        studentBindValues.STUDY_YEAR = studyYearFromBody;
      }

      const studentSql = `
        INSERT INTO STUDENTS (
          ${studentSqlColumns.join(", ")}
        ) VALUES (
          ${studentSqlValues.join(", ")}
        )
      `;

      studentResult = await connection.execute(studentSql, studentBindValues, {
        autoCommit: false,
      });
    }

    await connection.commit();

    return res.status(201).json({
      message: "✅ User added successfully",
      studentAdded: !!studentResult,
    });
  } catch (err) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackErr) {
        console.error("❌ Rollback error:", rollbackErr);
      }
    }

    console.error("❌ Error adding user:", err);
    return res.status(500).json({
      message: "❌ Error adding user",
      error: err.message,
    });
  } finally {
    if (connection) await connection.close();
  }
});

// 22. User CRUD operations - IMPROVED
app
.route("/users/:id")
  // GET single user
  .get(auth, async (req, res) => {
    const { id } = req.params;
    let connection;
    try {
      connection = await getConnection();

      const result = await connection.execute(
        `SELECT 
          u.USER_ID,
          u.FULL_NAME,
          u.CREATED_AT,
          u.EMAIL,
          u.IS_ACTIVE,
          u.IS_DEAN,
          u.ROLE,
          u.USERNAME,
          s.STUDENT_UNIVERSITY_ID,
          s.STUDY_YEAR
         FROM USERS u 
         LEFT JOIN STUDENTS s ON u.USER_ID = s.USER_ID 
         WHERE u.USER_ID = :id`,
        { id },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      if (!result.rows || result.rows.length === 0) {
        return res.status(404).json({ message: "User not found" });
      }

      return res.status(200).json(result.rows[0]);
    } catch (err) {
      console.error("❌ Error fetching user:", err);
      return res.status(500).json({
        message: "❌ Error fetching user",
        error: err.message,
      });
    } finally {
      if (connection) await connection.close();
    }
  })

  // UPDATE user
  .put(auth, async (req, res) => {
    const { id } = req.params;

    const parsedBody = parseJsonBody(req, res);
    if (parsedBody === null) return;

    let connection;
    try {
      connection = await getConnection();

      const updates = [];
      const bindValues = { id };

      if (
        parsedBody.IS_ACTIVE !== undefined &&
        parsedBody.IS_ACTIVE !== null &&
        parsedBody.IS_ACTIVE !== ""
      ) {
        updates.push("IS_ACTIVE = :is_active");
        bindValues.is_active =
          parsedBody.IS_ACTIVE === 0 || parsedBody.IS_ACTIVE === "0" ? 0 : 1;
      }

      if (
        parsedBody.IS_DEAN !== undefined &&
        parsedBody.IS_DEAN !== null &&
        parsedBody.IS_DEAN !== ""
      ) {
        updates.push("IS_DEAN = :is_dean");
        bindValues.is_dean = Number(parsedBody.IS_DEAN) ? 1 : 0;
      }

      // الحقول المتاحة في الجدول
      const fields = [
        "FULL_NAME",
        "USERNAME",
        "EMAIL",
        "ROLE",
      ];

      fields.forEach((field) => {
        if (
          parsedBody[field] !== undefined &&
          parsedBody[field] !== null &&
          parsedBody[field] !== ""
        ) {
          updates.push(`${field} = :${field.toLowerCase()}`);
          bindValues[field.toLowerCase()] = parsedBody[field];
        }
      });

      if (
        parsedBody.password ||
        parsedBody.PASSWORD ||
        parsedBody.PASSWORD_HASH
      ) {
        let newPasswordHash = parsedBody.PASSWORD_HASH;
        if (!newPasswordHash) {
          const rawPass = parsedBody.password || parsedBody.PASSWORD;
          newPasswordHash = await bcrypt.hash(rawPass, 10);
        }
        updates.push("PASSWORD_HASH = :password_hash");
        bindValues.password_hash = newPasswordHash;
      }

      if (updates.length === 0) {
        return res
          .status(400)
          .json({ message: "No valid fields to update" });
      }

      const setClause = updates.join(", ");
      const sql = `UPDATE USERS SET ${setClause} WHERE USER_ID = :id`;

      const result = await connection.execute(sql, bindValues, {
        autoCommit: false,
      });

      if (result.rowsAffected === 0) {
        await connection.rollback();
        return res.status(404).json({ message: "User not found" });
      }

      // تحديث جدول الطلاب لو STUDENT_UNIVERSITY_ID موجود
      const requestedStudentUniversityIdRaw =
        parsedBody.STUDENT_UNIVERSITY_ID ||
        parsedBody.STUDENT_ID ||
        parsedBody.studentUniversityId ||
        parsedBody.universityId;
      const requestedStudentUniversityId =
        typeof requestedStudentUniversityIdRaw === "string"
          ? requestedStudentUniversityIdRaw.trim()
          : requestedStudentUniversityIdRaw;
      const requestedStudyYear = extractStudyYear(parsedBody);

      let studentUpdateResult = false;
      const hasStudentPayload =
        (requestedStudentUniversityId &&
          requestedStudentUniversityId !== "") ||
        requestedStudyYear !== null;

      if (hasStudentPayload) {
        try {
          const checkStudentSql = `SELECT COUNT(*) AS COUNT FROM STUDENTS WHERE USER_ID = :id`;
          const checkResult = await connection.execute(
            checkStudentSql,
            { id },
            { outFormat: oracledb.OUT_FORMAT_OBJECT }
          );

          const updateBindings = { id };
          const updateColumns = [];

          if (
            requestedStudentUniversityId &&
            requestedStudentUniversityId !== ""
          ) {
            updateColumns.push(
              "STUDENT_UNIVERSITY_ID = :studentUniversityId"
            );
            updateBindings.studentUniversityId = requestedStudentUniversityId;
          }

          if (requestedStudyYear !== null) {
            updateColumns.push("STUDY_YEAR = :studyYear");
            updateBindings.studyYear = requestedStudyYear;
          }

          if (checkResult.rows[0].COUNT > 0) {
            if (updateColumns.length > 0) {
              const updateStudentSql = `
                UPDATE STUDENTS 
                SET ${updateColumns.join(", ")} 
                WHERE USER_ID = :id
              `;
              await connection.execute(updateStudentSql, updateBindings, {
                autoCommit: false,
              });
              studentUpdateResult = true;
            }
          } else {
            const insertColumns = ["USER_ID"];
            const insertValues = [":id"];
            const insertBindings = { id };

            if (
              requestedStudentUniversityId &&
              requestedStudentUniversityId !== ""
            ) {
              insertColumns.push("STUDENT_UNIVERSITY_ID");
              insertValues.push(":studentUniversityId");
              insertBindings.studentUniversityId = requestedStudentUniversityId;
            }

            if (requestedStudyYear !== null) {
              insertColumns.push("STUDY_YEAR");
              insertValues.push(":studyYear");
              insertBindings.studyYear = requestedStudyYear;
            }

            const insertStudentSql = `
              INSERT INTO STUDENTS (${insertColumns.join(", ")})
              VALUES (${insertValues.join(", ")})
            `;
            await connection.execute(insertStudentSql, insertBindings, {
              autoCommit: false,
            });
            studentUpdateResult = true;
          }
        } catch (studentErr) {
          console.error(
            "❌ Error updating STUDENTS table:",
            studentErr.message
          );
        }
      }

      await connection.commit();

      return res.status(200).json({
        message: "✅ User updated successfully",
        updatedFields: updates,
        studentUpdated: !!studentUpdateResult,
      });
    } catch (err) {
      if (connection) {
        try {
          await connection.rollback();
        } catch (rbErr) {
          console.error("❌ Rollback error (user update):", rbErr);
        }
      }
      console.error("❌ Error updating user:", err);
      return res.status(500).json({
        message: "❌ Error updating user",
        error: err.message,
      });
    } finally {
      if (connection) await connection.close();
    }
  })

  // DELETE user
  .delete(auth, async (req, res) => {
    const { id } = req.params;
    let connection;
    try {
      connection = await getConnection();

      const result = await connection.execute(
        `DELETE FROM USERS WHERE USER_ID = :id`,
        { id },
        { autoCommit: true }
      );

      if (result.rowsAffected === 0) {
        return res.status(404).json({ message: "User not found" });
      }

      return res.status(200).json({
        message: "✅ User deleted successfully",
        rowsAffected: result.rowsAffected,
      });
    } catch (err) {
      console.error("❌ Error deleting user:", err);
      return res.status(500).json({
        message: "❌ Error deleting user",
        error: err.message,
      });
    } finally {
      if (connection) await connection.close();
    }
  });

// 23. Login endpoint - IMPROVED
app.post("/login", async (req, res) => {
  let parsedBody;

  // معالجة البودي
  if (!req.body) {
    parsedBody = {};
  } else if (typeof req.body === "string") {
    try {
      parsedBody = JSON.parse(req.body);
    } catch (e) {
      return res.status(400).json({ message: "Invalid JSON body" });
    }
  } else {
    parsedBody = req.body;
  }

  if (!parsedBody.email || !parsedBody.password) {
    return res.status(400).json({ message: "Email and password are required" });
  }

  const { email, password } = parsedBody;
  let connection;

  try {
    // 🔥 تعديل واحد فقط — استخدم الـ Pool
    connection = await getConnection();

    const result = await connection.execute(
      `SELECT * FROM USERS 
       WHERE LOWER(email) = :email OR LOWER(username) = :email`,
      { email: email.toLowerCase() },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (!result.rows || result.rows.length === 0) {
      return res.status(401).json({ message: "No user found" });
    }

    const userRaw = result.rows[0];

    const passwordMatch = await bcrypt.compare(password, userRaw.PASSWORD_HASH);
    if (!passwordMatch) {
      return res.status(401).json({ message: "Invalid password" });
    }

    const safeUser = {};
    Object.keys(userRaw).forEach(key => {
      if (key !== "PASSWORD_HASH") safeUser[key] = userRaw[key];
    });

    const token = jwt.sign(
      {
        id: safeUser.USER_ID,
        email: safeUser.EMAIL,
        role: safeUser.ROLE,
      },
      process.env.JWT_SECRET,
      { expiresIn: "2h" }
    );

    return res.status(200).json({
      message: "Login successful",
      token,
      user: safeUser,
    });

} catch (err) {
  console.error("❌ Login Error:", err);
  return res.status(500).json({
    message: "❌ Error processing login",
    error: err.message,
  });
} finally {
  if (connection) await connection.close();
}
});





// 25. Get all doctors - IMPROVED
app.get("/doctors", async (req, res) => {
  let connection;
  try {
    connection = await getConnection();

    const result = await connection.execute(
      `
      SELECT 
        u.*,
        DBMS_LOB.SUBSTR(d.ALLOWED_FEATURES, 4000, 1) as ALLOWED_FEATURES,
        d.DOCTOR_TYPE,
        d.IS_ACTIVE
      FROM DOCTORS d 
      JOIN USERS u ON u.USER_ID = TO_CHAR(d.DOCTOR_ID)
      `,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const doctors = (result.rows || []).map((row) => {
      const safeRow = {};

      Object.keys(row).forEach((key) => {
        if (key === "IMAGE" || key === "ID_IMAGE") {
          safeRow[key] = typeof row[key] === "string" ? row[key] : "";
        } else if (key === "ALLOWED_FEATURES") {
          try {
            const featuresValue = row[key];
            if (
              featuresValue &&
              typeof featuresValue === "string" &&
              featuresValue.trim() !== ""
            ) {
              safeRow[key] = JSON.parse(featuresValue);
            } else {
              safeRow[key] = [];
            }
          } catch (e) {
            console.error(
              `❌ خطأ في تحويل ALLOWED_FEATURES للطبيب ${row.FULL_NAME}:`,
              e
            );
            safeRow[key] = [];
          }
        } else {
          safeRow[key] = row[key];
        }
      });

      const nameFromDb =
        row.FULL_NAME ||
        row.NAME ||
        row.FIRST_NAME ||
        row.USERNAME ||
        "";
      safeRow.name = nameFromDb;
      safeRow.fullName = row.FULL_NAME || nameFromDb;
      safeRow.uid = row.USER_ID;
      safeRow.id = row.USER_ID;
      safeRow.allowedFeatures = Array.isArray(safeRow.ALLOWED_FEATURES)
        ? safeRow.ALLOWED_FEATURES
        : [];

      let doctorType = "طبيب عام";
      if (row.DOCTOR_TYPE) {
        doctorType = row.DOCTOR_TYPE;
      } else if (row.ROLE) {
        doctorType = row.ROLE;
      }
      safeRow.type = doctorType;
      safeRow.DOCTOR_TYPE = doctorType;

      return safeRow;
    });

    return res.status(200).json(doctors);
  } catch (err) {
    console.error("❌ Error fetching doctors:", err);
    return res.status(500).json({
      message: "❌ Error fetching doctors",
      error: err.message,
    });
  } finally {
    if (connection) await connection.close();
  }
});

// 26. Get single doctor with features - FIXED VERSION
app.get("/doctors/:id", async (req, res) => {
  const { id } = req.params;
  let connection;
  try {
    connection = await getConnection();

    const sql = `
      SELECT 
        u.USER_ID,
        u.FULL_NAME,
        u.EMAIL,
        u.IS_ACTIVE,
        u.IS_DEAN,
        u.ROLE,
        u.USERNAME,
        d.DOCTOR_ID,
        d.DOCTOR_TYPE,
        d.IS_ACTIVE as DOCTOR_IS_ACTIVE,
        DBMS_LOB.SUBSTR(d.ALLOWED_FEATURES, 4000, 1) as ALLOWED_FEATURES
      FROM DOCTORS d 
      JOIN USERS u ON u.USER_ID = TO_CHAR(d.DOCTOR_ID)
      WHERE u.USER_ID = :id OR TO_CHAR(d.DOCTOR_ID) = :id
    `;

    const result = await connection.execute(sql, { id }, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
    });

    if (!result.rows || result.rows.length === 0) {
      return res.status(404).json({
        message: "Doctor not found",
        attemptedId: id,
        suggestion:
          "تأكد أن المستخدم موجود في جدول DOCTORS وله علاقة مع USERS",
      });
    }

    const doctor = result.rows[0];

    let allowedFeatures = [];
    try {
      const featuresValue = doctor.ALLOWED_FEATURES;
      if (
        featuresValue &&
        typeof featuresValue === "string" &&
        featuresValue.trim() !== ""
      ) {
        const parsed = JSON.parse(featuresValue);
        allowedFeatures = Array.isArray(parsed) ? parsed : [];
      }
    } catch (e) {
      console.error("❌ خطأ في تحويل ALLOWED_FEATURES:", e);
      allowedFeatures = [];
    }

    const [derivedFirstName = ""] = (doctor.FULL_NAME || "").split(" ");

    const response = {
      USER_ID: doctor.USER_ID,
      FULL_NAME: doctor.FULL_NAME,
      FIRST_NAME: derivedFirstName,
      FATHER_NAME: "",
      GRANDFATHER_NAME: "",
      FAMILY_NAME: "",
      GENDER: doctor.GENDER,
      BIRTH_DATE: doctor.BIRTH_DATE,
      EMAIL: doctor.EMAIL,
      PHONE: doctor.PHONE,
      ADDRESS: doctor.ADDRESS,
      ID_NUMBER: doctor.ID_NUMBER,
      IS_ACTIVE: doctor.IS_ACTIVE,
      IS_DEAN: doctor.IS_DEAN,
      ROLE: doctor.ROLE,
      USERNAME: doctor.USERNAME,

      DOCTOR_ID: doctor.DOCTOR_ID,
      DOCTOR_TYPE: doctor.DOCTOR_TYPE || "طبيب عام",
      DOCTOR_IS_ACTIVE: doctor.DOCTOR_IS_ACTIVE,

      ALLOWED_FEATURES: allowedFeatures,
      allowedFeatures: allowedFeatures,
    };

    return res.status(200).json(response);
  } catch (err) {
    console.error("❌ Error fetching doctor:", err);
    return res.status(500).json({
      message: "❌ Error fetching doctor",
      error: err.message,
      attemptedId: id,
    });
  } finally {
    if (connection) await connection.close();
  }
});

// 27. Get doctor type only
app.get("/doctors/:id/type", async (req, res) => {
  const { id } = req.params;
  let connection;
  try {
    connection = await getConnection();

    const result = await connection.execute(
      `SELECT DOCTOR_TYPE FROM DOCTORS WHERE DOCTOR_ID = TO_NUMBER(:id)`,
      { id },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (!result.rows || result.rows.length === 0) {
      return res.status(404).json({ message: "Doctor not found" });
    }

    const doctorType = result.rows[0].DOCTOR_TYPE || "طبيب عام";

    return res.status(200).json({
      doctorType,
      type: doctorType,
    });
  } catch (err) {
    console.error("❌ Error fetching doctor type:", err);
    return res.status(500).json({
      message: "❌ Error fetching doctor type",
      error: err.message,
    });
  } finally {
    if (connection) await connection.close();
  }
});

// 28. Update doctor type
app.put("/doctors/:id/type", auth, async (req, res) => {
  const { id } = req.params;
  const { doctorType } = req.body;

  if (!doctorType) {
    return res.status(400).json({ message: "Doctor type is required" });
  }

  let connection;
  try {
    connection = await getConnection();

    const sql = `UPDATE DOCTORS SET DOCTOR_TYPE = :doctorType WHERE DOCTOR_ID = TO_NUMBER(:id)`;
    const result = await connection.execute(
      sql,
      { doctorType, id },
      { autoCommit: true }
    );

    if (result.rowsAffected === 0) {
      return res.status(404).json({ message: "Doctor not found" });
    }

    return res
      .status(200)
      .json({ message: "✅ Doctor type updated successfully" });
  } catch (err) {
    console.error("❌ Error updating doctor type:", err);
    return res.status(500).json({
      message: "❌ Error updating doctor type",
      error: err.message,
    });
  } finally {
    if (connection) await connection.close();
  }
});

// 29. Update doctor features
app.put("/doctors/:id/features", auth, async (req, res) => {
  const { id } = req.params;
  const { allowedFeatures } = req.body;

  if (!Array.isArray(allowedFeatures)) {
    return res
      .status(400)
      .json({ message: "allowedFeatures must be an array" });
  }

  let connection;
  try {
    connection = await getConnection();

    const featuresJson = JSON.stringify(allowedFeatures);

    const sql = `
      UPDATE DOCTORS 
      SET ALLOWED_FEATURES = :features 
      WHERE DOCTOR_ID = TO_NUMBER(:id)
    `;
    const result = await connection.execute(
      sql,
      { features: featuresJson, id },
      { autoCommit: true }
    );

    if (result.rowsAffected === 0) {
      return res.status(404).json({ message: "Doctor not found" });
    }

    return res.status(200).json({
      message: "✅ Doctor features updated successfully",
      updatedFeatures: allowedFeatures,
    });
  } catch (err) {
    console.error("❌ Error updating doctor features:", err);
    return res.status(500).json({
      message: "❌ Error updating doctor features",
      error: err.message,
    });
  } finally {
    if (connection) await connection.close();
  }
});


// 30. Update multiple doctors features
app.put("/doctors/batch/features", auth, async (req, res) => {
  const { doctorIds, allowedFeatures } = req.body;

  if (!Array.isArray(doctorIds) || !Array.isArray(allowedFeatures)) {
    return res.status(400).json({
      message: "doctorIds and allowedFeatures must be arrays",
      doctorIdsType: typeof doctorIds,
      allowedFeaturesType: typeof allowedFeatures
    });
  }

  if (doctorIds.length === 0) {
    return res.status(400).json({ message: "doctorIds array is empty" });
  }

  let connection;
  try {
    connection = await getConnection();

    const featuresJson = JSON.stringify(allowedFeatures);
    let successCount = 0;

    const results = await Promise.all(
      doctorIds.map(async (doctorId) => {
        try {
          const sql = `UPDATE DOCTORS SET ALLOWED_FEATURES = :features WHERE DOCTOR_ID = :id`;
          const result = await connection.execute(
            sql,
            { features: featuresJson, id: doctorId },
            { autoCommit: false }
          );

          if (result.rowsAffected > 0) {
            successCount++;
            return { id: doctorId, status: "success" };
          }
          return { id: doctorId, status: "not_found" };
        } catch (err) {
          console.error(`❌ Error updating doctor ${doctorId}:`, err.message);
          return { id: doctorId, status: "error", error: err.message };
        }
      })
    );

    await connection.commit();

    const failedCount = results.filter(r => r.status !== "success").length;

    res.status(200).json({
      message: `✅ Updated ${successCount} doctors, ${failedCount} failed`,
      successCount,
      failedCount,
      details: results
    });

  } catch (err) {
    if (connection) {
      try { await connection.rollback(); } catch {}
    }
    res.status(500).json({ message: "❌ Error updating doctors", error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});


// 31. Simple batch update
app.put("/doctors/batch/features-simple", auth, async (req, res) => {
  const { doctorIds, allowedFeatures } = req.body;

  if (!Array.isArray(doctorIds) || !Array.isArray(allowedFeatures)) {
    return res.status(400).json({ message: "Invalid data format" });
  }

  let successCount = 0;
  let failCount = 0;
  const featuresJson = JSON.stringify(allowedFeatures);

  for (const doctorId of doctorIds) {
    let connection;
    try {
      connection = await getConnection();

      const sql = `UPDATE DOCTORS SET ALLOWED_FEATURES = :features WHERE DOCTOR_ID = :id`;
      const result = await connection.execute(
        sql,
        { features: featuresJson, id: doctorId },
        { autoCommit: true }
      );

      result.rowsAffected > 0 ? successCount++ : failCount++;
    } catch (err) {
      console.error(`❌ Error updating doctor ${doctorId}:`, err.message);
      failCount++;
    } finally {
      if (connection) await connection.close();
    }
  }

  res.status(200).json({
    message: `✅ Updated: ${successCount}, Failed: ${failCount}`,
    successCount,
    failCount
  });
});


// 32. Check if ID exists in pending users
app.post("/pendingUsers/check-id", auth, isAdmin, async (req, res) => {
  const { idNumber } = req.body;

  if (!idNumber) {
    return res.status(400).json({ message: "ID number is required" });
  }

  let connection;
  try {
    connection = await getConnection();

    const result = await connection.execute(
      `SELECT COUNT(*) AS COUNT FROM PENDINGUSERS WHERE IDNUMBER = :id`,
      { id: idNumber },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    result.rows[0].COUNT > 0
      ? res.status(409).json({ message: "ID number already exists in pending users" })
      : res.status(200).json({ message: "ID number is available" });

  } catch (err) {
    res.status(500).json({ message: "❌ Error checking ID", error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});


// 33. Create appointment
app.post("/appointments", async (req, res) => {
  const {
    appointment_date,
    start_time,
    end_time,
    student_id,
    patient_name,
    patient_id_number,
    student_university_id,
    status
  } = req.body;

  if (!appointment_date || !student_id || !status) {
    return res.status(400).json({ message: "❌ Missing required fields" });
  }

  let connection;
  try {
    connection = await getConnection();

    const dateOnly = appointment_date.split("T")[0];

    const sql = `
      INSERT INTO APPOINTMENTS (
        ID, APPOINTMENT_DATE, START_TIME, END_TIME,
        STUDENT_ID, PATIENT_NAME, PATIENT_ID_NUMBER,
        STUDENT_UNIVERSITY_ID, CREATED_AT, STATUS
      ) VALUES (
        :1, TO_DATE(:2, 'YYYY-MM-DD'), :3, :4,
        :5, :6, :7,
        :8, SYSTIMESTAMP, :9
      )
    `;

    // Positional binds avoid ORA-01745 from malformed bind names
    const bindValues = [
      Date.now(),
      dateOnly,
      start_time || "إقرار",
      end_time || "",
      student_id,
      patient_name || "",
      patient_id_number || "",
      student_university_id || "UNKNOWN",
      status || "pending"
    ];

    const result = await connection.execute(sql, bindValues, { autoCommit: true });

    res.status(201).json({
      message: "✅ Appointment created successfully",
      rowsAffected: result.rowsAffected
    });

  } catch (err) {
    res.status(500).json({ message: "❌ Failed to create appointment", error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});


// 34. Get appointment count
app.get("/appointments/count", async (req, res) => {
  const { date } = req.query;

  if (!date) {
    return res.status(400).json({ error: "Missing date parameter" });
  }

  let connection;
  try {
    connection = await getConnection();

    const result = await connection.execute(
      `SELECT COUNT(*) AS COUNT FROM APPOINTMENTS
       WHERE TO_CHAR(APPOINTMENT_DATE, 'YYYY-MM-DD') = :d`,
      { d: date.split("T")[0] },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    res.json({ count: result.rows[0].COUNT });

  } catch (err) {
    res.status(500).json({ error: "Failed to fetch appointment count", details: err.message });
  } finally {
    if (connection) await connection.close();
  }
});


// 35. Get booking settings
app.get("/bookingSettings", auth, async (req, res) => {
  let connection;
  try {
    connection = await getConnection();

    const result = await connection.execute(
      `SELECT FOURTH_YEAR_LIMIT, FIFTH_YEAR_LIMIT FROM BOOKING_SETTINGS`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "No booking settings found." });
    }

    res.json({
      fourthYearLimit: result.rows[0].FOURTH_YEAR_LIMIT,
      fifthYearLimit: result.rows[0].FIFTH_YEAR_LIMIT
    });

  } catch (err) {
    res.status(500).json({ error: "Failed to fetch booking settings.", details: err.message });
  } finally {
    if (connection) await connection.close();
  }
});


// 36. Get all waiting list entries
app.get("/waitingList", async (req, res) => {
  let connection;
  try {
    connection = await getConnection();

    const result = await connection.execute(
      `SELECT 
        w.WAITING_ID, w.PATIENT_UID, w.PATIENT_NAME,
        TO_CHAR(w.APPOINTMENT_DATE, 'YYYY-MM-DD') AS APPOINTMENT_DATE,
        w.PHONE, w.STATUS, w.NOTES,
        TO_CHAR(w.CREATED_AT, 'YYYY-MM-DD HH24:MI:SS') AS CREATED_AT,
        p.FIRSTNAME, p.FAMILYNAME, p.MEDICAL_RECORD_NO
      FROM WAITING_LIST w
      LEFT JOIN PATIENTS p ON w.PATIENT_UID = p.PATIENT_UID
      ORDER BY w.CREATED_AT DESC`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    res.status(200).json(result.rows);

  } catch (err) {
    res.status(500).json({ message: "❌ Error fetching waiting list", error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});


// 37. Add to waiting list
app.post("/waitingList", async (req, res) => {
  const { PATIENT_UID, PATIENT_NAME, APPOINTMENT_DATE, STATUS, PHONE, NOTES } = req.body;

  if (!PATIENT_UID || !PATIENT_NAME || !APPOINTMENT_DATE) {
    return res.status(400).json({
      message: "❌ Missing required fields",
      required: ["PATIENT_UID", "PATIENT_NAME", "APPOINTMENT_DATE"]
    });
  }

  let connection;
  try {
    connection = await getConnection();

    const appointmentDateValue = (APPOINTMENT_DATE || "").split("T")[0];

    // تحقق من وجود المريض
    const patientExists = await connection.execute(
      `SELECT COUNT(*) AS COUNT FROM PATIENTS WHERE PATIENT_UID = :id`,
      { id: PATIENT_UID },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (patientExists.rows[0].COUNT === 0) {
      return res.status(404).json({
        message: "❌ Patient not found in system",
        suggestion: "Approve patient first"
      });
    }

    // تحقق من التكرار
    const duplicate = await connection.execute(
      `SELECT COUNT(*) AS COUNT FROM WAITING_LIST
       WHERE PATIENT_UID = :1
       AND APPOINTMENT_DATE = TO_DATE(:2, 'YYYY-MM-DD')`,
      [PATIENT_UID, appointmentDateValue],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (duplicate.rows[0].COUNT > 0) {
      return res.status(409).json({ message: "❌ Patient already in waiting list for this date" });
    }

    // إضافة
    const result = await connection.execute(
      `INSERT INTO WAITING_LIST (
        WAITING_ID, PATIENT_UID, PATIENT_NAME,
        APPOINTMENT_DATE, STATUS, PHONE, NOTES, CREATED_AT
      ) VALUES (
        :1, :2, :3,
        TO_DATE(:4, 'YYYY-MM-DD'), :5, :6, :7, SYSTIMESTAMP
      )`,
      [
        `WL_${Date.now()}`,
        PATIENT_UID,
        PATIENT_NAME,
        appointmentDateValue,
        STATUS || "WAITING",
        PHONE || "",
        NOTES || ""
      ],
      { autoCommit: true }
    );

    res.status(201).json({
      message: "✅ Added to waiting list",
      rowsAffected: result.rowsAffected
    });

  } catch (err) {
    res.status(500).json({ message: "❌ Error adding to waiting list", error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});


// 38. Remove from waiting list
app.delete("/waitingList/:id", async (req, res) => {
  const { id } = req.params;

  let connection;
  try {
    connection = await getConnection();

    const result = await connection.execute(
      `DELETE FROM WAITING_LIST WHERE WAITING_ID = :id`,
      { id },
      { autoCommit: true }
    );

    if (result.rowsAffected === 0) {
      return res.status(404).json({ message: "❌ Entry not found" });
    }

    res.status(200).json({ message: "✅ Removed successfully" });

  } catch (err) {
    res.status(500).json({ message: "❌ Error removing", error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});


// 39. Get all patient exams
app.get("/patientExams", async (req, res) => {
  let connection;
  try {
    connection = await getConnection();

    let query = `
      SELECT e.*, p.FIRSTNAME, p.FAMILYNAME, p.MEDICAL_RECORD_NO
      FROM PATIENT_EXAMS e
      JOIN PATIENTS p ON e.PATIENT_UID = p.PATIENT_UID
    `;

    let binds = {};

    if (req.query.patientName && req.query.date) {
      query += ` WHERE e.PATIENT_NAME = :name AND e.APPOINTMENT_DATE = TO_DATE(:date, 'YYYY-MM-DD')`;
      binds = {
        name: req.query.patientName,
        date: req.query.date.split("T")[0]
      };
    }

    query += " ORDER BY e.EXAMINED_AT DESC";

    const result = await connection.execute(
      query,
      binds,
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    res.status(200).json(result.rows);

  } catch (err) {
    res.status(500).json({ message: "❌ Error fetching exams", error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

// 40 .Create new patient exam
app.post("/patientExams", async (req, res) => {
  const {
    PATIENT_UID,
    PATIENT_NAME,
    APPOINTMENT_DATE,
    EXAMINED_BY,
    EXAM_RESULTS,
    DIAGNOSIS,
    TREATMENT_PLAN,
    PRESCRIPTION,
    STATUS
  } = req.body;

  if (!PATIENT_UID || !PATIENT_NAME || !APPOINTMENT_DATE) {
    return res.status(400).json({ message: "❌ Missing required fields" });
  }

  let connection;
  try {
    connection = await getConnection();

    const sql = `
      INSERT INTO PATIENT_EXAMS (
        EXAM_ID, PATIENT_UID, PATIENT_NAME, APPOINTMENT_DATE,
        EXAMINED_BY, EXAM_RESULTS, DIAGNOSIS, TREATMENT_PLAN,
        PRESCRIPTION, STATUS, EXAMINED_AT
      ) VALUES (
        :exam_id, :patient_uid, :patient_name,
        TO_DATE(:appointment_date, 'YYYY-MM-DD'),
        :examined_by, :exam_results, :diagnosis,
        :treatment_plan, :prescription, :status, SYSTIMESTAMP
      )
    `;

    const bindValues = {
      exam_id: `EXAM_${Date.now()}`,
      patient_uid: PATIENT_UID,
      patient_name: PATIENT_NAME,
      appointment_date: APPOINTMENT_DATE.split("T")[0],
      examined_by: EXAMINED_BY || '',
      exam_results: EXAM_RESULTS || '',
      diagnosis: DIAGNOSIS || '',
      treatment_plan: TREATMENT_PLAN || '',
      prescription: PRESCRIPTION || '',
      status: STATUS || 'COMPLETED'
    };

    const result = await connection.execute(sql, bindValues, { autoCommit: true });
    res.status(201).json({ message: "✅ Exam added successfully", rowsAffected: result.rowsAffected });

  } catch (err) {
    console.error("❌ Error creating exam:", err);
    res.status(500).json({ message: "❌ Failed to create exam", error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});


// 41. Get all appointments
app.get("/appointments", async (req, res) => {
  let connection;
  try {
    connection = await getConnection();

    let query = `
      SELECT a.*, s.STUDENT_UNIVERSITY_ID,
             u.FULL_NAME AS STUDENT_NAME
      FROM APPOINTMENTS a
      LEFT JOIN STUDENTS s ON a.STUDENT_ID = s.USER_ID
      LEFT JOIN USERS u ON a.STUDENT_ID = u.USER_ID
    `;
    let binds = {};
    const { limit, offset } = getPagination(req, 0, 500);
    const pagination = buildPaginationClause(limit, offset);

    if (req.query.date) {
      query += ` WHERE TRUNC(a.APPOINTMENT_DATE) = TO_DATE(:date, 'YYYY-MM-DD')`;
      binds = { date: req.query.date.split("T")[0] };
    }

    query += ` ORDER BY a.APPOINTMENT_DATE, a.START_TIME${pagination.clause}`;
    binds = { ...binds, ...pagination.binds };

    const result = await connection.execute(
      query, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    res.status(200).json(result.rows);

  } catch (err) {
    console.error("❌ Error fetching appointments:", err);
    res.status(500).json({ message: "❌ Error fetching appointments", error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});


// 42. Get patient by ID
app.get("/patients/:id", async (req, res) => {
  const { id } = req.params;

  let connection;
  try {
    connection = await getConnection();

    const sql = `
      SELECT PATIENT_UID, FIRSTNAME, FATHERNAME, GRANDFATHERNAME,
             FAMILYNAME, IDNUMBER, BIRTHDATE, GENDER, ADDRESS,
             PHONE, IQRAR, IMAGE, IDIMAGE, MEDICAL_RECORD_NO,
             STATUS, CREATEDAT
      FROM PATIENTS
      WHERE PATIENT_UID = :id
    `;

    const result = await connection.execute(
      sql, { id }, { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: "❌ Patient not found",
        patientId: id
      });
    }

    res.status(200).json(result.rows[0]);

  } catch (err) {
    console.error("❌ Error fetching patient:", err);
    res.status(500).json({
      message: "❌ Error fetching patient",
      error: err.message
    });

  } finally {
    if (connection) await connection.close();
  }
});


// 43. Update booking settings
app.put("/bookingSettings", auth, async (req, res) => {
  const { fourthYearLimit, fifthYearLimit } = req.body;

  if (fourthYearLimit === undefined || fifthYearLimit === undefined) {
    return res.status(400).json({ message: "❌ Both limits are required" });
  }

  let connection;
  try {
    connection = await getConnection();

    await connection.execute(
      `UPDATE BOOKING_SETTINGS SET FOURTH_YEAR_LIMIT = :fourth, FIFTH_YEAR_LIMIT = :fifth`,
      { fourth: fourthYearLimit, fifth: fifthYearLimit },
      { autoCommit: true }
    );

    res.status(200).json({ message: "✅ Booking settings updated successfully" });

  } catch (err) {
    console.error("❌ Error updating booking settings:", err);
    res.status(500).json({ message: "❌ Failed updating booking settings", error: err.message });

  } finally {
    if (connection) await connection.close();
  }
});

// 44.NEW ENDPOINT: Add doctor to DOCTORS table
app.post("/doctors", auth, async (req, res) => {
  let { DOCTOR_ID, ALLOWED_FEATURES, DOCTOR_TYPE, IS_ACTIVE } = req.body;

  DOCTOR_ID = parseInt(DOCTOR_ID, 10);
  IS_ACTIVE = IS_ACTIVE !== undefined ? parseInt(IS_ACTIVE, 10) : 1;

  if (isNaN(DOCTOR_ID)) {
    return res.status(400).json({ message: "❌ DOCTOR_ID must be numeric" });
  }

  let connection;
  try {
    connection = await getConnection();

    const bindValues = {
      doctor_id: DOCTOR_ID,
      allowed_features: JSON.stringify(ALLOWED_FEATURES || []),
      doctor_type: DOCTOR_TYPE || 'طبيب عام',
      is_active: IS_ACTIVE
    };

    await connection.execute(
      `INSERT INTO DOCTORS 
        (DOCTOR_ID, ALLOWED_FEATURES, DOCTOR_TYPE, IS_ACTIVE, CREATED_AT, UPDATED_AT)
       VALUES 
        (:doctor_id, :allowed_features, :doctor_type, :is_active, SYSTIMESTAMP, SYSTIMESTAMP)
      `,
      bindValues,
      { autoCommit: true }
    );

    res.status(201).json({
      message: "✅ Doctor added successfully",
      doctorId: DOCTOR_ID
    });

  } catch (err) {
    console.error("❌ Error adding doctor:", err);
    res.status(500).json({
      message: "❌ Database Error",
      error: err.message,
      errorCode: err.errorNum
    });
  } finally {
    if (connection) await connection.close();
  }
});

// 45. Get all examinations with basic data - FINAL FIXED VERSION
app.get("/all-examinations-simple", auth, async (req, res) => {
  let connection;
  try {
    connection = await getConnection();

    const sql = `
      SELECT 
        e.EXAM_ID,
        e.PATIENT_UID,
        e.DOCTOR_ID,
        TO_CHAR(e.EXAM_DATE, 'YYYY-MM-DD HH24:MI:SS') as EXAM_DATE,
        e.NOTES,
        e.EXAM_DATA,
        e.SCREENING_DATA,
        e.DENTAL_FORM_DATA,
        p.FIRSTNAME,
        p.FATHERNAME,
        p.GRANDFATHERNAME,
        p.FAMILYNAME,
        p.IDNUMBER,
        TO_CHAR(p.BIRTHDATE, 'YYYY-MM-DD') as BIRTHDATE,
        p.GENDER,
        p.PHONE,
        p.MEDICAL_RECORD_NO,
        u.FULL_NAME as DOCTOR_NAME
      FROM EXAMINATIONS e
      LEFT JOIN PATIENTS p ON e.PATIENT_UID = p.PATIENT_UID
      LEFT JOIN USERS u ON e.DOCTOR_ID = u.USER_ID
      ORDER BY e.EXAM_DATE DESC
    `;

    const result = await connection.execute(sql, [], {
      outFormat: oracledb.OUT_FORMAT_OBJECT
    });

    if (!result.rows || result.rows.length === 0) {
      return res.status(200).json([]);
    }

    const examinations = result.rows.map(row => {
      return {
        EXAM_ID: String(row.EXAM_ID || ''),
        PATIENT_UID: String(row.PATIENT_UID || ''),
        DOCTOR_ID: String(row.DOCTOR_ID || ''),
        EXAM_DATE: String(row.EXAM_DATE || ''),
        NOTES: String(row.NOTES || ''),
        PATIENT_DATA: {
          FIRSTNAME: String(row.FIRSTNAME || ''),
          FATHERNAME: String(row.FATHERNAME || ''),
          GRANDFATHERNAME: String(row.GRANDFATHERNAME || ''),
          FAMILYNAME: String(row.FAMILYNAME || ''),
          IDNUMBER: String(row.IDNUMBER || ''),
          BIRTHDATE: String(row.BIRTHDATE || ''),
          GENDER: String(row.GENDER || ''),
          PHONE: String(row.PHONE || ''),
          MEDICAL_RECORD_NO: String(row.MEDICAL_RECORD_NO || '')
        },
        DOCTOR_DATA: {
          FULL_NAME: String(row.DOCTOR_NAME || 'Unknown Doctor')
        }
      };
    });

    res.status(200).json(examinations);

  } catch (err) {
    console.error("❌ Error fetching all examinations:", err);
    res.status(500).json({
      message: "❌ Error fetching examinations",
      error: err.message
    });
  } finally {
    if (connection) await connection.close();
  }
});

//46. Get full examination details by exam ID
app.get("/examination-details/:examId", auth, async (req, res) => {
  let connection;
  try {
    const { examId } = req.params;
    connection = await getConnection();

    const sql = `
      SELECT 
        e.EXAM_ID,
        e.PATIENT_UID,
        e.DOCTOR_ID,
        TO_CHAR(e.EXAM_DATE, 'YYYY-MM-DD HH24:MI:SS') as EXAM_DATE,
        e.NOTES,
        DBMS_LOB.SUBSTR(e.EXAM_DATA, 4000, 1) as EXAM_DATA_TEXT,
        DBMS_LOB.SUBSTR(e.SCREENING_DATA, 4000, 1) as SCREENING_DATA_TEXT,
        DBMS_LOB.SUBSTR(e.DENTAL_FORM_DATA, 4000, 1) as DENTAL_FORM_DATA_TEXT,
        p.FIRSTNAME,
        p.FATHERNAME,
        p.GRANDFATHERNAME,
        p.FAMILYNAME,
        p.IDNUMBER,
        TO_CHAR(p.BIRTHDATE, 'YYYY-MM-DD') as BIRTHDATE,
        p.GENDER,
        p.PHONE,
        p.MEDICAL_RECORD_NO,
        u.FULL_NAME as DOCTOR_NAME
      FROM EXAMINATIONS e
      LEFT JOIN PATIENTS p ON e.PATIENT_UID = p.PATIENT_UID
      LEFT JOIN USERS u ON e.DOCTOR_ID = u.USER_ID
      WHERE e.EXAM_ID = :examId
    `;

    const result = await connection.execute(
      sql,
      { examId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (!result.rows || result.rows.length === 0) {
      return res.status(404).json({ message: "❌ Examination not found" });
    }

    const row = result.rows[0];

    const safeParse = (txt) => {
      try {
        return txt ? JSON.parse(txt) : {};
      } catch {
        return {};
      }
    };

    res.status(200).json({
      EXAM_ID: row.EXAM_ID,
      PATIENT_UID: row.PATIENT_UID,
      DOCTOR_ID: row.DOCTOR_ID,
      EXAM_DATE: row.EXAM_DATE,
      NOTES: row.NOTES,
      EXAM_DATA: safeParse(row.EXAM_DATA_TEXT),
      SCREENING_DATA: safeParse(row.SCREENING_DATA_TEXT),
      DENTAL_FORM_DATA: safeParse(row.DENTAL_FORM_DATA_TEXT),
      PATIENT_DATA: {
        FIRSTNAME: row.FIRSTNAME,
        FATHERNAME: row.FATHERNAME,
        GRANDFATHERNAME: row.GRANDFATHERNAME,
        FAMILYNAME: row.FAMILYNAME,
        IDNUMBER: row.IDNUMBER,
        BIRTHDATE: row.BIRTHDATE,
        GENDER: row.GENDER,
        PHONE: row.PHONE,
        MEDICAL_RECORD_NO: row.MEDICAL_RECORD_NO
      },
      DOCTOR_DATA: { FULL_NAME: row.DOCTOR_NAME }
    });

  } catch (err) {
    console.error("❌ Error fetching examination details:", err);
    res.status(500).json({
      message: "❌ Error fetching examination details",
      error: err.message
    });
  } finally {
    if (connection) await connection.close();
  }
});

//47. Get all examinations with full data - FINAL FIXED VERSION
app.get("/all-examinations-full", auth, async (req, res) => {
  let connection;
  try {
    connection = await getConnection();
    const { limit, offset } = getPagination(req, 0, 300);
    const pagination = buildPaginationClause(limit, offset);

    const sql = `
      SELECT 
        e.EXAM_ID,
        e.PATIENT_UID,
        e.DOCTOR_ID,
        TO_CHAR(e.EXAM_DATE, 'YYYY-MM-DD HH24:MI:SS') as EXAM_DATE,
        e.NOTES,
        p.FIRSTNAME,
        p.FATHERNAME,
        p.GRANDFATHERNAME,
        p.FAMILYNAME,
        p.IDNUMBER,
        TO_CHAR(p.BIRTHDATE, 'YYYY-MM-DD') as BIRTHDATE,
        p.GENDER,
        p.PHONE,
        p.MEDICAL_RECORD_NO,
        p.IDIMAGE,
        p.IQRAR,
        p.IMAGE,
        u.FULL_NAME as DOCTOR_NAME
      FROM EXAMINATIONS e
      LEFT JOIN PATIENTS p ON e.PATIENT_UID = p.PATIENT_UID
      LEFT JOIN USERS u ON e.DOCTOR_ID = u.USER_ID
      ORDER BY e.EXAM_DATE DESC${pagination.clause}
    `;

    const result = await connection.execute(sql, pagination.binds, {
      outFormat: oracledb.OUT_FORMAT_OBJECT
    });

    const safe = (clob) => {
      if (!clob) return {};
      try { return JSON.parse(clob.toString()); }
      catch { return {}; }
    };

    const examinations = result.rows.map(row => ({
      EXAM_ID: row.EXAM_ID,
      PATIENT_UID: row.PATIENT_UID,
      DOCTOR_ID: row.DOCTOR_ID,
      EXAM_DATE: row.EXAM_DATE,
      NOTES: cleanNotesField(row.NOTES),
      PATIENT_DATA: {
        FIRSTNAME: row.FIRSTNAME,
        FATHERNAME: row.FATHERNAME,
        GRANDFATHERNAME: row.GRANDFATHERNAME,
        FAMILYNAME: row.FAMILYNAME,
        IDNUMBER: row.IDNUMBER,
        BIRTHDATE: row.BIRTHDATE,
        GENDER: row.GENDER,
        PHONE: row.PHONE,
        MEDICAL_RECORD_NO: row.MEDICAL_RECORD_NO,
        IDIMAGE: row.IDIMAGE,
        IQRAR: row.IQRAR,
        IMAGE: row.IMAGE
      },
      DOCTOR_DATA: {
        USER_ID: row.DOCTOR_ID,
        FULL_NAME: row.DOCTOR_NAME
      },
      EXAM_DATA: safe(row.EXAM_DATA),
      SCREENING_DATA: safe(row.SCREENING_DATA),
      DENTAL_FORM_DATA: safe(row.DENTAL_FORM_DATA)
    }));

    res.status(200).json(examinations);

  } catch (err) {
    console.error("❌ Error fetching examinations full:", err);
    res.status(500).json({
      message: "❌ Error",
      error: err.message
    });
  } finally {
    if (connection) await connection.close();
  }
});

// 48. Get examination by patient ID - المُحسَّن
app.get("/examinations/:patientId", auth, async (req, res) => {
  const { patientId } = req.params;

  let connection;
  try {
    connection = await getConnection();

    const sql = `
      SELECT *
      FROM examinations
      WHERE patient_uid = :patientId
      ORDER BY exam_date DESC
    `;

    const result = await connection.execute(
      sql,
      { patientId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (!result.rows || result.rows.length === 0) {
      return res.status(404).json({
        message: "❌ No examinations found for this patient",
        patientId
      });
    }

    const exams = result.rows.map(row => {
      const safeParse = (data) => {
        try {
          const str = typeof data === "object" ? data?.toString() : data;
          return str ? JSON.parse(str) : {};
        } catch {
          return {};
        }
      };

      return {
        exam_id: row.EXAM_ID,
        patient_uid: row.PATIENT_UID,
        doctor_id: row.DOCTOR_ID,
        exam_date: row.EXAM_DATE,
        notes: cleanNotesField(row.NOTES),
        exam_data: safeParse(row.EXAM_DATA),
        screening_data: safeParse(row.SCREENING_DATA),
        dental_form_data: safeParse(row.DENTAL_FORM_DATA)
      };
    });

    // إرجاع آخر فحص فقط
    res.status(200).json(exams[0]);

  } catch (err) {
    console.error("❌ Error fetching examination:", err);
    res.status(500).json({
      message: "❌ Error fetching examination",
      error: err.message
    });
  } finally {
    if (connection) await connection.close();
  }
});

// PUT /examinations/:examId
app.put('/examinations/:examId', auth, async (req, res) => {
  const conn = await oracledb.getConnection();
  try {
    const examId = req.params.examId;
    const {
      patient_uid,
      doctor_id,
      exam_date,
      exam_data,
      screening_data,
      dental_form_data,
      notes,
    } = req.body;

    // MERGE = upsert
    const sql = `
      MERGE INTO examinations t
      USING (SELECT :exam_id exam_id FROM dual) s
      ON (t.exam_id = s.exam_id)
      WHEN MATCHED THEN
        UPDATE SET
          patient_uid = :patient_uid,
          doctor_id = :doctor_id,
          exam_date = :exam_date,
          exam_data = :exam_data,
          screening_data = :screening_data,
          dental_form_data = :dental_form_data,
          notes = :notes
      WHEN NOT MATCHED THEN
        INSERT (exam_id, patient_uid, doctor_id, exam_date, exam_data, screening_data, dental_form_data, notes)
        VALUES (:exam_id, :patient_uid, :doctor_id, :exam_date, :exam_data, :screening_data, :dental_form_data, :notes)
    `;
    await conn.execute(sql, {
      exam_id: examId,
      patient_uid,
      doctor_id,
      exam_date,
      exam_data,
      screening_data,
      dental_form_data,
      notes,
    }, { autoCommit: true });

    res.status(200).json({ ok: true, exam_id: examId });
  } catch (err) {
    console.error('PUT /examinations/:examId error', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) await conn.close();
  }
});


// 49. Get all examinations - المُحسَّن
app.get("/all-examinations", auth, async (req, res) => {
  let connection;
  try {
    connection = await getConnection();
    const { limit, offset } = getPagination(req, 0, 300);
    const pagination = buildPaginationClause(limit, offset);

    const sql = `
      SELECT 
        e.EXAM_ID,
        e.PATIENT_UID,
        e.DOCTOR_ID,
        e.EXAM_DATE,
        e.EXAM_DATA,
        e.SCREENING_DATA,
        e.DENTAL_FORM_DATA,
        e.NOTES,
        p.FIRSTNAME,
        p.FATHERNAME,
        p.GRANDFATHERNAME,
        p.FAMILYNAME,
        p.IDNUMBER,
        p.BIRTHDATE,
        p.GENDER,
        p.PHONE,
        p.MEDICAL_RECORD_NO,
        p.IMAGE,
        p.IDIMAGE,
        u.FULL_NAME as DOCTOR_NAME,
      FROM EXAMINATIONS e
      LEFT JOIN PATIENTS p ON e.PATIENT_UID = p.PATIENT_UID
      LEFT JOIN USERS u ON e.DOCTOR_ID = u.USER_ID
      ORDER BY e.EXAM_DATE DESC${pagination.clause}
    `;

    const result = await connection.execute(sql, pagination.binds, {
      outFormat: oracledb.OUT_FORMAT_OBJECT
    });

    if (!result.rows || result.rows.length === 0) {
      return res.status(404).json({ message: "❌ No examinations found" });
    }

    const safeParse = (clob, fieldName) => {
      if (!clob) return null;

      try {
        const data =
          typeof clob === "object" && clob !== null
            ? clob?.toString()
            : clob;

        return data && data.trim() !== "" ? parseDoubleEncodedJSON(data) : null;

      } catch (err) {
        console.error(`❌ Error parsing ${fieldName}:`, err.message);
        return { error: err.message };
      }
    };

    const examinations = result.rows.map(row => {
      return {
        EXAM_ID: row.EXAM_ID,
        PATIENT_UID: row.PATIENT_UID,
        DOCTOR_ID: row.DOCTOR_ID,
        EXAM_DATE: row.EXAM_DATE,
        NOTES: cleanNotesField(row.NOTES),
        PATIENT_DATA: {
          PATIENT_UID: row.PATIENT_UID,
          FIRSTNAME: row.FIRSTNAME,
          FATHERNAME: row.FATHERNAME,
          GRANDFATHERNAME: row.GRANDFATHERNAME,
          FAMILYNAME: row.FAMILYNAME,
          IDNUMBER: row.IDNUMBER,
          BIRTHDATE: row.BIRTHDATE,
          GENDER: row.GENDER,
          PHONE: row.PHONE,
          MEDICAL_RECORD_NO: row.MEDICAL_RECORD_NO,
          IMAGE: row.IMAGE,
          IDIMAGE: row.IDIMAGE
        },
        DOCTOR_DATA: {
          USER_ID: row.DOCTOR_ID,
          FULL_NAME: row.DOCTOR_NAME,
          IMAGE: row.DOCTOR_IMAGE
        },
        EXAM_DATA: safeParse(row.EXAM_DATA, "EXAM_DATA"),
        SCREENING_DATA: safeParse(row.SCREENING_DATA, "SCREENING_DATA"),
        DENTAL_FORM_DATA: safeParse(row.DENTAL_FORM_DATA, "DENTAL_FORM_DATA")
      };
    });

    res.status(200).json(examinations);

  } catch (err) {
    console.error("❌ Error fetching all examinations:", err);
    res.status(500).json({
      message: "❌ Error fetching examinations",
      error: err.message
    });
  } finally {
    if (connection) await connection.close();
  }
});

// 50. Get single examination with full CLOB data - المُحسَّن
app.get("/examination-full/:examId", auth, async (req, res) => {
  let connection;
  try {
    const { examId } = req.params;
    connection = await getConnection();

    const sql = `
      SELECT 
        EXAM_ID,
        PATIENT_UID,
        DOCTOR_ID,
        EXAM_DATE,
        NOTES,
        DBMS_LOB.SUBSTR(EXAM_DATA, 4000, 1) as EXAM_DATA_TEXT,
        DBMS_LOB.SUBSTR(SCREENING_DATA, 4000, 1) as SCREENING_DATA_TEXT,
        DBMS_LOB.SUBSTR(DENTAL_FORM_DATA, 4000, 1) as DENTAL_FORM_DATA_TEXT
      FROM EXAMINATIONS 
      WHERE EXAM_ID = :examId
    `;

    const result = await connection.execute(
      sql,
      { examId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (!result.rows || result.rows.length === 0) {
      return res.status(404).json({ message: "❌ Examination not found" });
    }

    const row = result.rows[0];

    const safeParse = (txt) => {
      try {
        return txt ? parseDoubleEncodedJSON(txt) : {};
      } catch {
        return {};
      }
    };

    res.status(200).json({
      EXAM_ID: row.EXAM_ID,
      PATIENT_UID: row.PATIENT_UID,
      DOCTOR_ID: row.DOCTOR_ID,
      EXAM_DATE: row.EXAM_DATE,
      NOTES: cleanNotesField(row.NOTES),
      EXAM_DATA: safeParse(row.EXAM_DATA_TEXT),
      SCREENING_DATA: safeParse(row.SCREENING_DATA_TEXT),
      DENTAL_FORM_DATA: safeParse(row.DENTAL_FORM_DATA_TEXT)
    });

  } catch (err) {
    console.error("❌ Error fetching examination:", err);
    res.status(500).json({
      message: "❌ Error fetching examination",
      error: err.message
    });
  } finally {
    if (connection) await connection.close();
  }
});

// 51. Get all x-ray requests (optional filters)
// Supports:
// - status: filter by status (default: pending)
// - doctorId: filter by doctor_uid/doctor_id
app.get("/xray_requests", async (req, res) => {
  let connection;
  const { status = "pending", doctorId, limit } = req.query;

  const limitNum = Math.max(
    1,
    Math.min(parseInt(limit, 10) || 200, 500) // cap to avoid heavy queries
  );

  try {
    connection = await getConnection();

    const sql = `
      SELECT *
      FROM (
        SELECT 
        REQUEST_ID as request_id,
        PATIENT_ID as patient_id,
        PATIENT_NAME as patient_name,
        STUDENT_ID as student_id,
        STUDENT_NAME as student_name,
        STUDENT_FULL_NAME as student_full_name,
        STUDENT_YEAR as student_year,
        XRAY_TYPE as xray_type,
        JAW as jaw,
        OCCLUSAL_JAW as occlusal_jaw,
        CBCT_JAW as cbct_jaw,
        SIDE as side,
        TOOTH as tooth,

        CASE WHEN GROUP_TEETH IS NOT NULL THEN DBMS_LOB.SUBSTR(GROUP_TEETH, 4000, 1) END AS group_teeth,
        CASE WHEN PERIAPICAL_TEETH IS NOT NULL THEN DBMS_LOB.SUBSTR(PERIAPICAL_TEETH, 4000, 1) END AS periapical_teeth,
        CASE WHEN BITEWING_TEETH IS NOT NULL THEN DBMS_LOB.SUBSTR(BITEWING_TEETH, 4000, 1) END AS bitewing_teeth,

        TO_CHAR(TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') AS timestamp,
        STATUS as status,
        COMPLETED_BY as completed_by,
        TO_CHAR(COMPLETED_AT, 'YYYY-MM-DD HH24:MI:SS') AS completed_at,
        DOCTOR_NAME as doctor_name,
        CLINIC as clinic,
        DOCTOR_UID as doctor_uid,
        DOCTOR_UID as doctor_id,
        TO_CHAR(CREATED_AT, 'YYYY-MM-DD HH24:MI:SS') AS created_at,
        IMAGE as image
      FROM XRAY_REQUESTS
      WHERE (:status IS NULL OR STATUS = :status)
        AND (:doctorId IS NULL OR DOCTOR_UID = :doctorId)
      ORDER BY CREATED_AT DESC
      )
      WHERE ROWNUM <= :limitNum
    `;

    const binds = {
      status: status ? status.toString() : null,
      doctorId: doctorId ? doctorId.toString() : null,
      limitNum
    };

    const result = await connection.execute(sql, binds, {
      outFormat: oracledb.OUT_FORMAT_OBJECT
    });

    const safeParse = (txt) => {
      if (!txt) return [];
      try {
        return JSON.parse(txt);
      } catch {
        return [];
      }
    };

    const requests = result.rows.map(row => ({
      ...row,
      group_teeth: safeParse(row.group_teeth),
      periapical_teeth: safeParse(row.periapical_teeth),
      bitewing_teeth: safeParse(row.bitewing_teeth)
    }));

    res.status(200).json(requests);

  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({
      message: "❌ Error",
      error: err.message
    });
  } finally {
    if (connection) await connection.close();
  }
});

// 52. Update x-ray request status (with image handoff to XRAY_IMAGES)
app.put("/xray_requests/:requestId/status", auth, async (req, res) => {
  const { requestId } = req.params;
  const { status, completedAt, completedBy, imageUrl, capturedAt } = req.body;

  if (!status) {
    return res.status(400).json({ message: "❌ Status is required" });
  }

  let connection;
  try {
    connection = await getConnection();

    // جلب بيانات الطلب لاستخدامها عند إنشاء سجل الصورة
    const reqResult = await connection.execute(
      `SELECT REQUEST_ID, PATIENT_ID, PATIENT_NAME, STUDENT_ID, STUDENT_NAME, STUDENT_YEAR, XRAY_TYPE, IMAGE, CLINIC
         FROM XRAY_REQUESTS
        WHERE REQUEST_ID = :requestId`,
      { requestId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const requestRow = reqResult.rows?.[0];
    if (!requestRow) {
      return res.status(404).json({ message: "❌ X-ray request not found" });
    }

    // محاولة جلب سنة دراسة الطالب من جدول USERS إذا لم تكن موجودة في الطلب
    let studentYearFromUsers = null;
    if (requestRow.STUDENT_ID) {
      try {
        const userRow = await connection.execute(
          `SELECT STUDY_YEAR FROM STUDENTS WHERE USER_ID = :id`,
          { id: requestRow.STUDENT_ID },
          { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        studentYearFromUsers = userRow.rows?.[0]?.STUDY_YEAR ?? null;
      } catch (e) {
        console.warn("⚠️ Could not fetch STUDY_YEAR from USERS:", e.message);
      }
    }

    const studyYearToUse = requestRow.STUDENT_YEAR ?? studentYearFromUsers ?? null;
    const clinicToUse = requestRow.CLINIC ?? null;

    const nowIso = new Date().toISOString();
    const completedAtIso = completedAt || nowIso;
    const capturedAtIso = capturedAt || nowIso;
    const imageUrlToUse = imageUrl || requestRow.IMAGE;

    if (status === "completed") {
      if (imageUrlToUse) {
        // إدراج سجل جديد في XRAY_IMAGES مع وقت التصوير والسنة الدراسية والعيادة
        await connection.execute(
          `
          INSERT INTO XRAY_IMAGES (
            IMAGE_ID, REQUEST_ID, PATIENT_ID, PATIENT_NAME,
            STUDENT_ID, STUDENT_NAME, XRAY_TYPE, IMAGE_URL,
            UPLOADED_AT, UPLOADED_BY, STATUS, CAPTURED_AT, STUDY_YEAR, CLINIC
          ) VALUES (
            :imageId, :requestId, :patientId, :patientName,
            :studentId, :studentName, :xrayType, :imageUrl,
            TO_TIMESTAMP(:uploadedAt, 'YYYY-MM-DD"T"HH24:MI:SS.FF3"Z"'),
            :uploadedBy, :status,
            TO_TIMESTAMP(:capturedAt, 'YYYY-MM-DD"T"HH24:MI:SS.FF3"Z"'),
            :studyYear, :clinic
          )
          `,
          {
            imageId: uuidv4(),
            requestId,
            patientId: requestRow.PATIENT_ID,
            patientName: requestRow.PATIENT_NAME,
            studentId: requestRow.STUDENT_ID,
            studentName: requestRow.STUDENT_NAME,
            xrayType: requestRow.XRAY_TYPE,
            imageUrl: imageUrlToUse,
            uploadedAt: nowIso,
            uploadedBy: completedBy || "فني الأشعة",
            status,
            capturedAt: capturedAtIso,
            studyYear: studyYearToUse,
            clinic: clinicToUse
          }
        );
      }

      // تحديث الطلب: حالة مكتملة + إضافة وقت الإكمال + تفريغ الصورة من الطلب
      const result = await connection.execute(
        `
        UPDATE XRAY_REQUESTS
           SET STATUS = :status,
               COMPLETED_AT = TO_TIMESTAMP(:completedAt, 'YYYY-MM-DD"T"HH24:MI:SS.FF3"Z"'),
               COMPLETED_BY = :completedBy,
               IMAGE = NULL
         WHERE REQUEST_ID = :requestId
        `,
        {
          status,
          completedAt: completedAtIso,
          completedBy: completedBy || "فني الأشعة",
          requestId
        }
      );

      if (result.rowsAffected === 0) {
        await connection.rollback();
        return res.status(404).json({ message: "❌ X-ray request not found" });
      }

      await connection.commit();
    } else {
      const result = await connection.execute(
        `UPDATE XRAY_REQUESTS SET STATUS = :status WHERE REQUEST_ID = :requestId`,
        { status, requestId },
        { autoCommit: true }
      );

      if (result.rowsAffected === 0) {
        return res.status(404).json({ message: "❌ X-ray request not found" });
      }
    }

    res.status(200).json({
      message: "✅ X-ray request status updated successfully",
      requestId,
      newStatus: status
    });

  } catch (err) {
    if (connection) await connection.rollback();
    console.error("❌ Error updating xray request status:", err);
    res.status(500).json({
      message: "❌ Error updating xray request status",
      error: err.message
    });
  } finally {
    if (connection) await connection.close();
  }
});

// 54. Insert daily X-ray report
app.post("/xray_daily_reports", async (req, res) => {
  const data = req.body;

  let connection;
  try {
    connection = await getConnection();

    const sql = `
      INSERT INTO xray_daily_reports (
        report_id, date, patient_name, patient_id, xray_type,
        clinic, student_name, student_year, doctor_name,
        completed_at, technician_name
      ) VALUES (
        :report_id,
        TO_DATE(:date, 'YYYY-MM-DD'),
        :patient_name,
        :patient_id,
        :xray_type,
        :clinic,
        :student_name,
        :student_year,
        :doctor_name,
        TO_TIMESTAMP(:completed_at, 'YYYY-MM-DD"T"HH24:MI:SS.FF3"Z"'),
        :technician_name
      )
    `;

    const bindValues = {
      report_id: `REP_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      ...data
    };

    const result = await connection.execute(sql, bindValues, { autoCommit: true });

    res.status(201).json({
      message: "✅ Daily report added successfully",
      reportId: bindValues.report_id,
      rowsAffected: result.rowsAffected
    });

  } catch (err) {
    console.error("❌ Error adding daily report:", err);
    res.status(500).json({
      message: "❌ Error adding daily report",
      error: err.message
    });
  } finally {
    if (connection) await connection.close();
  }
});

// 55. Radiology technician profile - improved
app.get("/radiology/profile", async (req, res) => {
  let connection;

  try {
    connection = await getConnection();

    const sql = `
      SELECT 
        USER_ID,
        FULL_NAME,
        IS_DEAN,
        NULL as image
      FROM USERS
      WHERE ROLE LIKE '%radiology%' OR ROLE LIKE '%أشعة%'
      AND ROWNUM = 1
    `;

    const result = await connection.execute(sql, [], {
      outFormat: oracledb.OUT_FORMAT_OBJECT
    });

    if (result.rows.length > 0) {
      const user = result.rows[0];
      const fullName = user.FULL_NAME || user.fullName || "فني الأشعة";
      const [firstName = "فني"] = fullName.split(" ");
      return res.status(200).json({
        firstName,
        fatherName: "",
        grandfatherName: "",
        familyName: "",
        fullName,
        image: user.image || ""
      });
    }

    // default fallback
    res.status(200).json({
      firstName: "فني",
      fatherName: "الأشعة",
      grandfatherName: "",
      familyName: "",
      fullName: "فني الأشعة",
      image: ""
    });

  } catch (err) {
    console.error("❌ Error fetching radiology profile:", err);

    res.status(200).json({
      firstName: "فني",
      fatherName: "الأشعة",
      grandfatherName: "",
      familyName: "",
      fullName: "فني الأشعة",
      image: ""
    });
  } finally {
    if (connection) await connection.close();
  }
});

// 56. Get all students with user data - improved
app.get("/students-with-users", async (req, res) => {
  let connection;

  try {
    connection = await getConnection();

    const sql = `
      SELECT 
        u.USER_ID,
        u.FULL_NAME,
        u.USERNAME,
        u.EMAIL,
        u.ROLE,
        u.IS_ACTIVE,
        u.IS_DEAN,
        u.CREATED_AT,
        s.STUDENT_UNIVERSITY_ID,
        s.STUDY_YEAR
      FROM USERS u
      INNER JOIN STUDENTS s ON u.USER_ID = s.USER_ID
      WHERE u.ROLE LIKE '%dental_student%' OR u.ROLE LIKE '%طالب%'
      ORDER BY u.FULL_NAME
    `;

    const result = await connection.execute(sql, [], {
      outFormat: oracledb.OUT_FORMAT_OBJECT
    });

    const students = result.rows.map(s => {
      const fullName = (s.FULL_NAME || "").trim();
      const [firstName = ""] = fullName.split(" ");

      return {
        id: s.USER_ID,
        userId: s.USER_ID,
        firstName,
        fatherName: "",
        grandfatherName: "",
        familyName: "",
        fullName,
        username: s.USERNAME || "",
        email: s.EMAIL || "",
        role: s.ROLE || "",
        isActive: s.IS_ACTIVE,
        isDean: s.IS_DEAN ?? 0,
        createdAt: s.CREATED_AT,
        universityId: s.STUDENT_UNIVERSITY_ID || "",
        studentUniversityId: s.STUDENT_UNIVERSITY_ID || "",
        studyYear: s.STUDY_YEAR ?? null
      };
    });

    res.status(200).json(students);

  } catch (err) {
    console.error("❌ Error fetching students:", err);
    res.status(500).json({
      message: "❌ Error fetching students",
      error: err.message
    });
  } finally {
    if (connection) await connection.close();
  }
});


// 61. Save xray image URL (image already uploaded to Oracle Object Storage)
app.post("/xray_images", async (req, res) => {
  const {
    request_id,
    patient_id,
    patient_name,
    xray_type,
    image_url,      // from Object Storage
    student_id,
    captured_at     // optional, ISO; fallback now
  } = req.body;

  if (!request_id || !image_url || !xray_type) {
    return res.status(400).json({
      success: false,
      message: "❌ request_id, image_url, xray_type مطلوبين"
    });
  }

  let connection;
  try {
    connection = await getConnection();

    // Pull request details if available to fill missing fields
    let fallback = {};
    try {
      const reqRow = await connection.execute(
        `SELECT PATIENT_ID, PATIENT_NAME, STUDENT_ID, STUDENT_NAME, XRAY_TYPE, STUDENT_YEAR, CLINIC
         FROM XRAY_REQUESTS WHERE REQUEST_ID = :id`,
        { id: request_id },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      fallback = reqRow.rows?.[0] || {};
    } catch (e) {
      console.warn("⚠️ Could not fetch XRAY_REQUESTS for fallback:", e.message);
    }

    // Get student name/year if student_id exists
    let student_name = null;
    let student_year = null;
    if (student_id) {
      const st = await connection.execute(
        `SELECT FULL_NAME, STUDY_YEAR FROM STUDENTS WHERE USER_ID = :id`,
        { id: student_id },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      student_name = st.rows[0]?.FULL_NAME || null;
      student_year = st.rows[0]?.STUDY_YEAR ?? null;
    }

    const sql = `
      INSERT INTO XRAY_IMAGES (
        IMAGE_ID, REQUEST_ID, PATIENT_ID, PATIENT_NAME,
        STUDENT_ID, STUDENT_NAME, XRAY_TYPE,
        IMAGE_URL, UPLOADED_AT, STUDY_YEAR, CLINIC, CAPTURED_AT
      ) VALUES (
        :img_id, :req, :pid, :pname,
        :sid, :sname, :type,
        :url, SYSTIMESTAMP, :study_year, :clinic,
        TO_TIMESTAMP(:captured_at, 'YYYY-MM-DD"T"HH24:MI:SS.FF3"Z"')
      )
    `;

    const bind = {
      img_id: `IMG_${Date.now()}`,
      req: request_id,
      pid: patient_id || fallback.PATIENT_ID || null,
      pname: patient_name || fallback.PATIENT_NAME || null,
      sid: student_id || fallback.STUDENT_ID || null,
      sname: student_name || fallback.STUDENT_NAME || null,
      type: xray_type || fallback.XRAY_TYPE,
      url: image_url,
      study_year: student_year ?? fallback.STUDENT_YEAR ?? null,
      clinic: fallback.CLINIC || null,
      captured_at: captured_at || new Date().toISOString()
    };

    await connection.execute(sql, bind, { autoCommit: false });

    // Clean up the original request for cleanliness
    await connection.execute(
      `DELETE FROM XRAY_REQUESTS WHERE REQUEST_ID = :id`,
      { id: request_id },
      { autoCommit: false }
    );

    await connection.commit();

    res.status(200).json({
      success: true,
      message: "✅ تم حفظ رابط الصورة بنجاح",
      imageId: bind.img_id
    });

  } catch (err) {
    console.error("❌ Error saving xray image:", err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  } finally {
    if (connection) await connection.close();
  }
});


app.get("/xray-images/patient/:patientId", async (req, res) => {
  const { patientId } = req.params;
  let connection;

  try {
    connection = await getConnection();

    const query = `
      SELECT 
        IMAGE_ID AS image_id,
        REQUEST_ID AS request_id,
        PATIENT_ID AS patient_id,
        PATIENT_NAME AS patient_name,
        STUDENT_ID AS student_id,
        STUDENT_NAME AS student_name,
        XRAY_TYPE AS xray_type,
        IMAGE_URL AS image_url,
        TO_CHAR(UPLOADED_AT, 'YYYY-MM-DD HH24:MI:SS') AS uploaded_at
      FROM XRAY_IMAGES
      WHERE PATIENT_ID = :pid
      ORDER BY UPLOADED_AT DESC
    `;

    const result = await connection.execute(
      query,
      { pid: patientId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    res.status(200).json(result.rows);
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json([]);
  } finally {
    if (connection) await connection.close();
  }
});

app.get("/xray-images/request/:requestId", async (req, res) => {
  const { requestId } = req.params;
  let connection;

  try {
    connection = await getConnection();

    const query = `
      SELECT 
        IMAGE_ID,
        REQUEST_ID,
        PATIENT_ID,
        PATIENT_NAME,
        STUDENT_ID,
        STUDENT_NAME,
        XRAY_TYPE,
        IMAGE_URL,
        TO_CHAR(UPLOADED_AT, 'YYYY-MM-DD HH24:MI:SS') AS UPLOADED_AT
      FROM XRAY_IMAGES
      WHERE REQUEST_ID = :id
      ORDER BY UPLOADED_AT DESC
    `;

    const result = await connection.execute(
      query,
      { id: requestId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    res.status(200).json(result.rows);
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json([]);
  } finally {
    if (connection) await connection.close();
  }
});

// 63. X-ray images report (grouped by type, clinic, year)
app.get("/xray-images/report", async (req, res) => {
  const { startDate, endDate } = req.query;

  if (!startDate || !endDate) {
    return res.status(400).json({ message: "startDate and endDate are required (YYYY-MM-DD)" });
  }

  let connection;
  try {
    connection = await getConnection();

    const sql = `
      SELECT 
        XRAY_TYPE,
        CLINIC,
        SUM(CASE WHEN STUDY_YEAR = 4 THEN 1 ELSE 0 END) AS YEAR4_COUNT,
        SUM(CASE WHEN STUDY_YEAR = 5 THEN 1 ELSE 0 END) AS YEAR5_COUNT
      FROM XRAY_IMAGES
      WHERE TRUNC(UPLOADED_AT) BETWEEN TO_DATE(:startDate, 'YYYY-MM-DD') AND TO_DATE(:endDate, 'YYYY-MM-DD')
      GROUP BY XRAY_TYPE, CLINIC
      ORDER BY XRAY_TYPE, CLINIC
    `;

    const result = await connection.execute(
      sql,
      { startDate, endDate },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    res.status(200).json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching xray images report:", err);
    res.status(500).json({
      message: "❌ Error fetching xray images report",
      error: err.message
    });
  } finally {
    if (connection) await connection.close();
  }
});



app.delete("/xray-images/:imageId", async (req, res) => {
  const { imageId } = req.params;
  let connection;

  try {
    connection = await getConnection();

    const result = await connection.execute(
      `DELETE FROM XRAY_IMAGES WHERE IMAGE_ID = :id`,
      { id: imageId },
      { autoCommit: true }
    );

    if (result.rowsAffected === 0) {
      return res.status(404).json({ message: "❌ Image not found" });
    }

    res.status(200).json({
      message: "✅ تم حذف صورة الأشعة بنجاح",
      imageId
    });

  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});


app.get("/check-xray-requests", async (req, res) => {
  let connection;
  try {
    connection = await getConnection();

    const query = `
      SELECT 
        REQUEST_ID as request_id,
        PATIENT_ID as patient_id,
        PATIENT_NAME as patient_name,
        STUDENT_ID as student_id,
        STUDENT_NAME as student_name,
        STUDENT_FULL_NAME as student_full_name,
        STUDENT_YEAR as student_year,
        XRAY_TYPE as xray_type,
        JAW as jaw,
        OCCLUSAL_JAW as occlusal_jaw,
        CBCT_JAW as cbct_jaw,
        SIDE as side,
        TOOTH as tooth,
        CASE WHEN GROUP_TEETH IS NOT NULL THEN DBMS_LOB.SUBSTR(GROUP_TEETH, 4000, 1) END AS group_teeth,
        CASE WHEN PERIAPICAL_TEETH IS NOT NULL THEN DBMS_LOB.SUBSTR(PERIAPICAL_TEETH, 4000, 1) END AS periapical_teeth,
        CASE WHEN BITEWING_TEETH IS NOT NULL THEN DBMS_LOB.SUBSTR(BITEWING_TEETH, 4000, 1) END AS bitewing_teeth,
        TO_CHAR(TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') AS timestamp,
        STATUS as status,
        DOCTOR_NAME as doctor_name,
        CLINIC as clinic,
        DOCTOR_UID as doctor_uid,
        TO_CHAR(CREATED_AT, 'YYYY-MM-DD HH24:MI:SS') AS created_at,
        COMPLETED_BY as completed_by,
        TO_CHAR(COMPLETED_AT, 'YYYY-MM-DD HH24:MI:SS') AS completed_at,
        IMAGE as image
      FROM XRAY_REQUESTS
      ORDER BY CREATED_AT DESC
    `;

    const result = await connection.execute(
      query, {}, 
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const safeParse = (txt) => {
      if (!txt) return [];
      try {
        return JSON.parse(txt);
      } catch {
        return [];
      }
    };

    const requests = result.rows.map(row => ({
      ...row,
      group_teeth: safeParse(row.group_teeth),
      periapical_teeth: safeParse(row.periapical_teeth),
      bitewing_teeth: safeParse(row.bitewing_teeth)
    }));

    res.json({ requests });
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

// 66. NEW ENDPOINT: Add xray request
app.post("/xray_requests", async (req, res) => {
  const {
    patientId,
    patientName,
    studentId,
    studentName,
    studentFullName,
    studentYear,
    xrayType,
    jaw,
    occlusalJaw,
    cbctJaw,
    side,
    tooth,
    groupTeeth,
    periapicalTeeth,
    bitewingTeeth,
    doctorName,
    clinic,
    doctorUid,
    doctorId,
    image
  } = req.body;

  if (!patientId || !patientName || !xrayType) {
    return res.status(400).json({
      message: "❌ Missing required fields",
      required: ['patientId', 'patientName', 'xrayType']
    });
  }

  let connection;
  try {
    connection = await getConnection();
    const requestId = `XR_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const query = `
      INSERT INTO XRAY_REQUESTS (
        REQUEST_ID, PATIENT_ID, PATIENT_NAME, STUDENT_ID, STUDENT_NAME,
        STUDENT_FULL_NAME, STUDENT_YEAR, XRAY_TYPE, JAW, OCCLUSAL_JAW,
        CBCT_JAW, SIDE, TOOTH, GROUP_TEETH, PERIAPICAL_TEETH, BITEWING_TEETH,
        DOCTOR_NAME, CLINIC, DOCTOR_UID, CREATED_AT, STATUS, TIMESTAMP, IMAGE
      ) VALUES (
        :request_id, :patient_id, :patient_name, :student_id, :student_name,
        :student_full_name, :student_year, :xray_type, :jaw, :occlusal_jaw,
        :cbct_jaw, :side, :tooth, :group_teeth, :periapical_teeth, :bitewing_teeth,
        :doctor_name, :clinic, :doctor_uid, SYSTIMESTAMP, 'pending', SYSTIMESTAMP, :image
      )
    `;

    const values = {
      request_id: requestId,
      patient_id: patientId,
      patient_name: patientName,
      student_id: studentId || null,
      student_name: studentName || null,
      student_full_name: studentFullName || studentName || null,
      student_year: studentYear || null,
      xray_type: xrayType,
      jaw: jaw || null,
      occlusal_jaw: occlusalJaw || null,
      cbct_jaw: cbctJaw || null,
      side: side || null,
      tooth: tooth || null,
      group_teeth: groupTeeth ? JSON.stringify(groupTeeth) : null,
      periapical_teeth: periapicalTeeth ? JSON.stringify(periapicalTeeth) : null,
      bitewing_teeth: bitewingTeeth ? JSON.stringify(bitewingTeeth) : null,
      doctor_name: doctorName || null,
      clinic: clinic || null,
      doctor_uid: doctorUid || doctorId || null,
      image: image || null
    };

    const result = await connection.execute(query, values, { autoCommit: true });

    res.status(201).json({
      message: 'تم إرسال طلب الأشعة بنجاح',
      requestId,
      rowsAffected: result.rowsAffected
    });

  } catch (error) {
    res.status(500).json({ error: "فشل إرسال الطلب", details: error.message });
  } finally {
    if (connection) await connection.close();
  }
});

// 66b. Update an existing xray request (details)
app.put("/xray_requests/:requestId", async (req, res) => {
  const { requestId } = req.params;
  const {
    patientId,
    patientName,
    studentId,
    studentName,
    studentFullName,
    studentYear,
    xrayType,
    jaw,
    occlusalJaw,
    cbctJaw,
    side,
    tooth,
    groupTeeth,
    periapicalTeeth,
    bitewingTeeth,
    doctorName,
    clinic,
    doctorUid,
    doctorId,
    status
  } = req.body;

  let connection;
  try {
    connection = await getConnection();

    const updateQuery = `
      UPDATE XRAY_REQUESTS SET
        PATIENT_ID = :patient_id,
        PATIENT_NAME = :patient_name,
        STUDENT_ID = :student_id,
        STUDENT_NAME = :student_name,
        STUDENT_FULL_NAME = :student_full_name,
        STUDENT_YEAR = :student_year,
        XRAY_TYPE = :xray_type,
        JAW = :jaw,
        OCCLUSAL_JAW = :occlusal_jaw,
        CBCT_JAW = :cbct_jaw,
        SIDE = :side,
        TOOTH = :tooth,
        GROUP_TEETH = :group_teeth,
        PERIAPICAL_TEETH = :periapical_teeth,
        BITEWING_TEETH = :bitewing_teeth,
        DOCTOR_NAME = :doctor_name,
        CLINIC = :clinic,
        DOCTOR_UID = :doctor_uid,
        STATUS = :status
      WHERE REQUEST_ID = :request_id
    `;

    const binds = {
      request_id: requestId,
      patient_id: patientId,
      patient_name: patientName,
      student_id: studentId || null,
      student_name: studentName || null,
      student_full_name: studentFullName || studentName || null,
      student_year: studentYear || null,
      xray_type: xrayType,
      jaw: jaw || null,
      occlusal_jaw: occlusalJaw || null,
      cbct_jaw: cbctJaw || null,
      side: side || null,
      tooth: tooth || null,
      group_teeth: groupTeeth ? JSON.stringify(groupTeeth) : null,
      periapical_teeth: periapicalTeeth ? JSON.stringify(periapicalTeeth) : null,
      bitewing_teeth: bitewingTeeth ? JSON.stringify(bitewingTeeth) : null,
      doctor_name: doctorName || null,
      clinic: clinic || null,
      doctor_uid: doctorUid || doctorId || null,
      status: status || "pending"
    };

    const result = await connection.execute(updateQuery, binds, { autoCommit: true });

    if (result.rowsAffected === 0) {
      return res.status(404).json({ message: "❌ X-ray request not found" });
    }

    res.status(200).json({ message: "✅ X-ray request updated successfully", requestId });
  } catch (error) {
    console.error("❌ Error updating xray request:", error);
    res.status(500).json({ error: "❌ Error updating xray request", details: error.message });
  } finally {
    if (connection) await connection.close();
  }
});


// 67. GET endpoint لجلب الطلبات المكتملة للطالب
app.get('/student-xray-requests/:studentId', async (req, res) => {
  const { studentId } = req.params;

  let connection;
  try {
    connection = await getConnection();

    const query = `
      SELECT 
        REQUEST_ID as request_id,
        PATIENT_ID as patient_id,
        PATIENT_NAME as patient_name,
        STUDENT_ID as student_id,
        STUDENT_NAME as student_name,
        STUDENT_FULL_NAME as student_full_name,
        STUDENT_YEAR as student_year,
        XRAY_TYPE as xray_type,
        JAW as jaw,
        OCCLUSAL_JAW as occlusal_jaw,
        CBCT_JAW as cbct_jaw,
        SIDE as side,
        TOOTH as tooth,
        CASE WHEN GROUP_TEETH IS NOT NULL THEN DBMS_LOB.SUBSTR(GROUP_TEETH, 4000, 1) END AS group_teeth,
        CASE WHEN PERIAPICAL_TEETH IS NOT NULL THEN DBMS_LOB.SUBSTR(PERIAPICAL_TEETH, 4000, 1) END AS periapical_teeth,
        CASE WHEN BITEWING_TEETH IS NOT NULL THEN DBMS_LOB.SUBSTR(BITEWING_TEETH, 4000, 1) END AS bitewing_teeth,
        CLINIC as clinic,
        DOCTOR_NAME as doctor_name,
        TO_CHAR(CREATED_AT, 'YYYY-MM-DD HH24:MI:SS') AS created_at,
        STATUS as status,
        TO_CHAR(COMPLETED_AT, 'YYYY-MM-DD HH24:MI:SS') AS completed_at,
        COMPLETED_BY as completed_by,
        IMAGE as image
      FROM XRAY_REQUESTS 
      WHERE STUDENT_ID = :studentId 
        AND STATUS = 'completed'
      ORDER BY CREATED_AT DESC
    `;

    const result = await connection.execute(
      query,
      { studentId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const safeParse = (txt) => {
      if (!txt) return [];
      try {
        return JSON.parse(txt);
      } catch {
        return [];
      }
    };

    const data = result.rows.map(row => ({
      ...row,
      group_teeth: safeParse(row.group_teeth),
      periapical_teeth: safeParse(row.periapical_teeth),
      bitewing_teeth: safeParse(row.bitewing_teeth)
    }));

    res.json({ success: true, data });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (connection) await connection.close();
  }
});

// 68. Update xray image URL (Oracle)
app.patch("/update-xray-image-url", async (req, res) => {
  let connection;
  try {
    const { requestId, studentId, imageUrl } = req.body;

    if (!requestId || !imageUrl) {
      return res.status(400).json({
        success: false,
        error: "requestId و imageUrl مطلوبان"
      });
    }

    connection = await getConnection();

    const updateSQL = `
      UPDATE XRAY_REQUESTS 
      SET 
        IMAGE = :image_url,
        STATUS = 'completed',
        COMPLETED_AT = SYSTIMESTAMP,
        COMPLETED_BY = :student_id
      WHERE REQUEST_ID = :request_id
    `;

    const result = await connection.execute(
      updateSQL,
      {
        image_url: imageUrl,
        student_id: studentId,
        request_id: requestId
      },
      { autoCommit: true }
    );

    if (result.rowsAffected === 0) {
      return res.status(404).json({ success: false, error: "لم يتم العثور على الطلب" });
    }

    res.json({
      success: true,
      message: "تم تحديث صورة الأشعة بنجاح",
      requestId,
      imageUrl
    });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

// 69. GET pending requests للطالب
app.get('/api/student-xray-requests/:studentId', async (req, res) => {
  const { studentId } = req.params;

  let connection;
  try {
    connection = await getConnection();

    const query = `
      SELECT 
        REQUEST_ID as request_id,
        PATIENT_ID as patient_id,
        PATIENT_NAME as patient_name,
        STUDENT_ID as student_id,
        STUDENT_NAME as student_name,
        STUDENT_FULL_NAME as student_full_name,
        STUDENT_YEAR as student_year,
        XRAY_TYPE as xray_type,
        JAW as jaw,
        OCCLUSAL_JAW as occlusal_jaw,
        CBCT_JAW as cbct_jaw,
        SIDE as side,
        TOOTH as tooth,
        CASE WHEN GROUP_TEETH IS NOT NULL THEN DBMS_LOB.SUBSTR(GROUP_TEETH, 4000, 1) END AS group_teeth,
        CASE WHEN PERIAPICAL_TEETH IS NOT NULL THEN DBMS_LOB.SUBSTR(PERIAPICAL_TEETH, 4000, 1) END AS periapical_teeth,
        CASE WHEN BITEWING_TEETH IS NOT NULL THEN DBMS_LOB.SUBSTR(BITEWING_TEETH, 4000, 1) END AS bitewing_teeth,
        CLINIC as clinic,
        DOCTOR_NAME as doctor_name,
        TO_CHAR(CREATED_AT, 'YYYY-MM-DD HH24:MI:SS') AS created_at,
        STATUS as status,
        IMAGE as image,
        TO_CHAR(COMPLETED_AT, 'YYYY-MM-DD HH24:MI:SS') AS completed_at,
        COMPLETED_BY as completed_by,
        CASE WHEN IMAGE IS NOT NULL THEN 1 ELSE 0 END AS IS_UPLOADED
      FROM XRAY_REQUESTS 
      WHERE STUDENT_ID = :studentId 
        AND STATUS = 'pending'
      ORDER BY CREATED_AT DESC
    `;

    const result = await connection.execute(
      query,
      { studentId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const safeParse = (txt) => {
      if (!txt) return [];
      try {
        return JSON.parse(txt);
      } catch {
        return [];
      }
    };

    const data = result.rows.map(row => ({
      ...row,
      group_teeth: safeParse(row.group_teeth),
      periapical_teeth: safeParse(row.periapical_teeth),
      bitewing_teeth: safeParse(row.bitewing_teeth),
      is_uploaded: row.IS_UPLOADED === 1
    }));

    res.json({ success: true, data });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (connection) await connection.close();
  }
});

// 70. Add new clinical procedure
app.post("/clinical_procedures", async (req, res) => {
  const {
    PROCEDURE_ID,
    CLINIC_NAME,
    DATE_OF_OPERATION,
    DATE_OF_SECOND_VISIT,
    PATIENT_ID,
    PATIENT_ID_NUMBER,
    PATIENT_NAME,
    STUDENT_NAME,
    SUPERVISOR_NAME,
    TOOTH_NO,
    TYPE_OF_OPERATION
  } = req.body;

  if (!PROCEDURE_ID || !PATIENT_ID_NUMBER || !PATIENT_NAME) {
    return res.status(400).json({ 
      message: "❌ Missing required fields",
      required: ['PROCEDURE_ID', 'PATIENT_ID_NUMBER', 'PATIENT_NAME']
    });
  }

  let connection;
  try {
    connection = await getConnection();

    const sql = `
      INSERT INTO CLINICAL_PROCEDURES (
        PROCEDURE_ID,
        CLINIC_NAME,
        CREATED_AT,
        DATE_OF_OPERATION,
        DATE_OF_SECOND_VISIT,
        PATIENT_ID,
        PATIENT_ID_NUMBER,
        PATIENT_NAME,
        STUDENT_NAME,
        SUPERVISOR_NAME,
        TOOTH_NO,
        TYPE_OF_OPERATION,
        CREATED_DATE,
        LAST_UPDATED
      ) VALUES (
        :PROCEDURE_ID,
        :CLINIC_NAME,
        SYSTIMESTAMP,
        TO_DATE(:DATE_OF_OPERATION, 'YYYY-MM-DD'),
        TO_DATE(:DATE_OF_SECOND_VISIT, 'YYYY-MM-DD'),
        :PATIENT_ID,
        :PATIENT_ID_NUMBER,
        :PATIENT_NAME,
        :STUDENT_NAME,
        :SUPERVISOR_NAME,
        :TOOTH_NO,
        :TYPE_OF_OPERATION,
        SYSTIMESTAMP,
        SYSTIMESTAMP
      )
    `;

    const bindValues = {
      PROCEDURE_ID,
      CLINIC_NAME: CLINIC_NAME || null,
      DATE_OF_OPERATION: DATE_OF_OPERATION || null,
      DATE_OF_SECOND_VISIT: DATE_OF_SECOND_VISIT || null,
      PATIENT_ID: PATIENT_ID || null,
      PATIENT_ID_NUMBER,
      PATIENT_NAME,
      STUDENT_NAME: STUDENT_NAME || null,
      SUPERVISOR_NAME: SUPERVISOR_NAME || null,
      TOOTH_NO: TOOTH_NO || null,
      TYPE_OF_OPERATION: TYPE_OF_OPERATION || null
    };

    const result = await connection.execute(sql, bindValues, { autoCommit: true });

    res.status(201).json({ 
      message: "✅ Clinical procedure saved successfully",
      PROCEDURE_ID,
      rowsAffected: result.rowsAffected
    });

  } catch (err) {
    console.error("❌ Error saving clinical procedure:", err);

    let errorMessage = "❌ Error saving clinical procedure";
    if (err.errorNum === 1) errorMessage = "❌ Procedure ID already exists";
    if (err.errorNum === 1847 || err.errorNum === 1861)
      errorMessage = "❌ Invalid date format. Use YYYY-MM-DD";

    res.status(500).json({ 
      message: errorMessage, 
      error: err.message,
      errorCode: err.errorNum
    });
  } finally {
    if (connection) await connection.close();
  }
});

// 71. Get clinical procedures by patient ID
app.get("/clinical_procedures/patient/:patientId", async (req, res) => {
  const { patientId } = req.params;
  let connection;

  try {
    connection = await getConnection();

    const result = await connection.execute(
      `SELECT 
        PROCEDURE_ID,
        CLINIC_NAME,
        TO_CHAR(CREATED_AT, 'YYYY-MM-DD HH24:MI:SS') as CREATED_AT,
        TO_CHAR(DATE_OF_OPERATION, 'YYYY-MM-DD') as DATE_OF_OPERATION,
        TO_CHAR(DATE_OF_SECOND_VISIT, 'YYYY-MM-DD') as DATE_OF_SECOND_VISIT,
        PATIENT_ID,
        PATIENT_ID_NUMBER,
        PATIENT_NAME,
        STUDENT_NAME,
        SUPERVISOR_NAME,
        TOOTH_NO,
        TYPE_OF_OPERATION,
        TO_CHAR(CREATED_DATE, 'YYYY-MM-DD HH24:MI:SS') as CREATED_DATE,
        TO_CHAR(LAST_UPDATED, 'YYYY-MM-DD HH24:MI:SS') as LAST_UPDATED
      FROM CLINICAL_PROCEDURES
      WHERE PATIENT_ID = :patientId OR PATIENT_ID_NUMBER = :patientId
      ORDER BY DATE_OF_OPERATION DESC`,
      { patientId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (!result.rows || result.rows.length === 0) {
      return res.status(404).json({ 
        message: "❌ No clinical procedures found for this patient",
        patientId
      });
    }

    res.status(200).json(result.rows);

  } catch (err) {
    console.error("❌ Error fetching patient clinical procedures:", err);
    res.status(500).json({
      message: "❌ Error fetching patient clinical procedures",
      error: err.message
    });
  } finally {
    if (connection) await connection.close();
  }
});

// 72. Update clinical procedure
app.put("/clinical_procedures/:procedureId", async (req, res) => {
  const { procedureId } = req.params;
  const updateData = req.body;

  if (!updateData || Object.keys(updateData).length === 0) {
    return res.status(400).json({ message: "❌ No data provided for update" });
  }

  let connection;
  try {
    connection = await getConnection();

    const allowedFields = [
      'CLINIC_NAME', 'DATE_OF_OPERATION', 'DATE_OF_SECOND_VISIT',
      'PATIENT_ID', 'PATIENT_ID_NUMBER', 'PATIENT_NAME',
      'STUDENT_NAME', 'SUPERVISOR_NAME', 'TOOTH_NO', 'TYPE_OF_OPERATION'
    ];

    const setClause = [];
    const bindValues = { procedureId };

    allowedFields.forEach(field => {
      if (updateData[field] !== undefined) {
        if (field === 'DATE_OF_OPERATION' || field === 'DATE_OF_SECOND_VISIT') {
          setClause.push(`${field} = TO_DATE(:${field}, 'YYYY-MM-DD')`);
          bindValues[field] = updateData[field];
        } else {
          setClause.push(`${field} = :${field}`);
          bindValues[field] = updateData[field];
        }
      }
    });

    // Always update LAST_UPDATED
    setClause.push('LAST_UPDATED = SYSTIMESTAMP');

    if (setClause.length === 0) {
      return res.status(400).json({ message: "❌ No valid fields to update" });
    }

    const sql = `
      UPDATE CLINICAL_PROCEDURES 
      SET ${setClause.join(', ')} 
      WHERE PROCEDURE_ID = :procedureId
    `;

    const result = await connection.execute(sql, bindValues, { autoCommit: true });

    if (result.rowsAffected === 0) {
      return res.status(404).json({ message: "❌ Clinical procedure not found" });
    }

    res.status(200).json({
      message: "✅ Clinical procedure updated successfully",
      procedureId,
      updatedFields: setClause
    });

  } catch (err) {
    console.error("❌ Error updating clinical procedure:", err);
    res.status(500).json({
      message: "❌ Error updating clinical procedure",
      error: err.message
    });
  } finally {
    if (connection) await connection.close();
  }
});

// 73. Add new prescription (Clean)
app.post("/prescriptions", async (req, res) => {
  const data = req.body || {};

  const {
    PATIENT_ID,
    PATIENT_NAME,
    MEDICINE_NAME,
    QUANTITY = '1',
    USAGE_TIME = null,
    DOCTOR_NAME,
    DOCTOR_UID,
    PRESCRIPTION_DATE = new Date().toISOString().split("T")[0]
  } = data;

  if (!PATIENT_ID || !PATIENT_NAME || !MEDICINE_NAME || !DOCTOR_NAME || !DOCTOR_UID) {
    return res.status(400).json({
      message: "❌ Missing required fields",
      required: ['PATIENT_ID', 'PATIENT_NAME', 'MEDICINE_NAME', 'DOCTOR_NAME', 'DOCTOR_UID']
    });
  }

  let connection;
  try {
    connection = await getConnection();

    const sql = `
      INSERT INTO PRESCRIPTIONS (
        PRESCRIPTION_ID, PATIENT_ID, PATIENT_NAME,
        MEDICINE_NAME, QUANTITY, USAGE_TIME,
        DOCTOR_NAME, DOCTOR_UID,
        CREATED_DATE, PRESCRIPTION_DATE
      ) VALUES (
        :id, :pid, :pname,
        :mname, :qty, :utime,
        :dname, :duid,
        SYSTIMESTAMP, TO_DATE(:pdate, 'YYYY-MM-DD')
      )
    `;

    const prescriptionId = `PRESC_${Date.now()}`;

    await connection.execute(sql, {
      id: prescriptionId,
      pid: PATIENT_ID,
      pname: PATIENT_NAME,
      mname: MEDICINE_NAME,
      qty: QUANTITY,
      utime: USAGE_TIME,
      dname: DOCTOR_NAME,
      duid: DOCTOR_UID,
      pdate: PRESCRIPTION_DATE
    }, { autoCommit: true });

    res.status(201).json({
      message: "✅ Prescription saved successfully",
      PRESCRIPTION_ID: prescriptionId
    });

  } catch (err) {
    console.error("❌ Error saving prescription:", err);

    let msg = "❌ Error saving prescription";
    if (err.errorNum === 1) msg = "❌ Prescription ID already exists";
    if ([1847, 1861].includes(err.errorNum)) msg = "❌ Invalid date format";

    res.status(500).json({ message: msg, error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});


// 74. Get prescriptions by patient ID
app.get("/prescriptions/patient/:patientId", async (req, res) => {
  const { patientId } = req.params;

  let connection;
  try {
    connection = await getConnection();

    const sql = `
      SELECT 
        PRESCRIPTION_ID, PATIENT_ID, PATIENT_NAME,
        MEDICINE_NAME, QUANTITY, USAGE_TIME,
        DOCTOR_NAME, DOCTOR_UID,
        TO_CHAR(CREATED_DATE,'YYYY-MM-DD HH24:MI:SS') AS CREATED_DATE,
        TO_CHAR(PRESCRIPTION_DATE,'YYYY-MM-DD') AS PRESCRIPTION_DATE
      FROM PRESCRIPTIONS
      WHERE PATIENT_ID = :pid
      ORDER BY CREATED_DATE DESC
    `;

    const result = await connection.execute(sql, { pid: patientId }, {
      outFormat: oracledb.OUT_FORMAT_OBJECT
    });

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: "❌ No prescriptions found",
        patientId
      });
    }

    res.json(result.rows);

  } catch (err) {
    console.error("❌ Error fetching prescriptions:", err);
    res.status(500).json({ message: "❌ Error fetching prescriptions" });
  } finally {
    if (connection) await connection.close();
  }
});


// 75. Update prescription
app.put("/prescriptions/:prescriptionId", async (req, res) => {
  const { prescriptionId } = req.params;
  const data = req.body || {};
  const DOCTOR_UID = data.DOCTOR_UID;

  if (!DOCTOR_UID) {
    return res.status(400).json({ message: "❌ DOCTOR_UID is required" });
  }

  let connection;
  try {
    connection = await getConnection();

    // Verify ownership
    const owner = await connection.execute(
      `SELECT DOCTOR_UID FROM PRESCRIPTIONS WHERE PRESCRIPTION_ID = :id`,
      { id: prescriptionId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (owner.rows.length === 0) {
      return res.status(404).json({ message: "❌ Prescription not found" });
    }

    if (owner.rows[0].DOCTOR_UID !== DOCTOR_UID) {
      return res.status(403).json({
        message: "❌ You can only update your own prescriptions"
      });
    }

    const allowed = [
      "PATIENT_ID", "PATIENT_NAME", "MEDICINE_NAME", "QUANTITY",
      "USAGE_TIME", "DOCTOR_NAME", "PRESCRIPTION_DATE"
    ];

    const set = [];
    const binds = { id: prescriptionId };

    allowed.forEach(field => {
      if (data[field] !== undefined) {
        if (field === "PRESCRIPTION_DATE") {
          set.push(`${field} = TO_DATE(:${field}, 'YYYY-MM-DD')`);
        } else {
          set.push(`${field} = :${field}`);
        }
        binds[field] = data[field];
      }
    });

    if (set.length === 0) {
      return res.status(400).json({ message: "❌ No valid fields to update" });
    }

    const sql = `UPDATE PRESCRIPTIONS SET ${set.join(", ")} WHERE PRESCRIPTION_ID = :id`;

    await connection.execute(sql, binds, { autoCommit: true });

    res.json({
      message: "✅ Prescription updated successfully",
      updatedFields: set
    });

  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ message: "❌ Error updating prescription" });
  } finally {
    if (connection) await connection.close();
  }
});


// 76. Delete prescription
app.delete("/prescriptions/:prescriptionId", async (req, res) => {
  const { prescriptionId } = req.params;
  const doctorUid = req.query.doctorUid;

  if (!doctorUid) {
    return res.status(400).json({ message: "❌ doctorUid is required" });
  }

  let connection;
  try {
    connection = await getConnection();

    const owner = await connection.execute(
      `SELECT DOCTOR_UID FROM PRESCRIPTIONS WHERE PRESCRIPTION_ID = :id`,
      { id: prescriptionId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (owner.rows.length === 0) {
      return res.status(404).json({ message: "❌ Prescription not found" });
    }

    if (owner.rows[0].DOCTOR_UID !== doctorUid) {
      return res.status(403).json({
        message: "❌ You can only delete your own prescriptions"
      });
    }

    await connection.execute(
      `DELETE FROM PRESCRIPTIONS WHERE PRESCRIPTION_ID = :id`,
      { id: prescriptionId },
      { autoCommit: true }
    );

    res.json({ message: "✅ Prescription deleted successfully" });

  } catch (err) {
    console.error("❌ Delete error:", err);
    res.status(500).json({ message: "❌ Error deleting prescription" });
  } finally {
    if (connection) await connection.close();
  }
});


// 77. Get active assignments
app.get("/patient_assignments", async (req, res) => {
  let connection;
  try {
    connection = await getConnection();

    const sql = `
      SELECT ASSIGNMENT_ID, STUDENT_ID, PATIENT_UID,
             ASSIGNED_DATE, STATUS
      FROM STUDENT_ASSIGNMENTS
      WHERE STATUS = 'ACTIVE'
    `;

    const result = await connection.execute(sql, [], {
      outFormat: oracledb.OUT_FORMAT_OBJECT
    });

    res.json(result.rows || []);

  } catch (err) {
    console.error("❌ Error fetching assignments:", err);
    res.json([]); // نرجع مصفوفة بدل خطأ
  } finally {
    if (connection) await connection.close();
  }
});


// 78. Assign patient to student (clean version)
app.post('/assign_patient_to_student', auth, async (req, res) => {
  const { patient_id, student_id } = req.body;
  if (!patient_id || !student_id) {
    return res.status(400).json({ error: 'patient_id و student_id مطلوبان' });
  }

  let connection;
  try {
    connection = await getConnection();

    // Check patient exists
    const patient = await connection.execute(
      'SELECT 1 FROM PATIENTS WHERE PATIENT_UID = :pid',
      { pid: patient_id },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    if (!patient.rows.length) {
      return res.status(404).json({ error: 'المريض غير موجود' });
    }

    // Check student exists
    const student = await connection.execute(
      'SELECT 1 FROM USERS WHERE USER_ID = :sid',
      { sid: student_id },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    if (!student.rows.length) {
      return res.status(404).json({ error: 'الطالب غير موجود' });
    }

    // Prevent duplicate assignment for same student
    const exists = await connection.execute(
      `SELECT 1 FROM STUDENT_ASSIGNMENTS 
       WHERE PATIENT_UID = :pid AND STUDENT_ID = :sid AND STATUS = 'ACTIVE'`,
      { pid: patient_id, sid: student_id },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (exists.rows.length) {
      return res.status(400).json({
        error: 'المريض معين مسبقاً لهذا الطالب نفسه'
      });
    }

    const assignmentId = `ASSIGN_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    await connection.execute(
      `INSERT INTO STUDENT_ASSIGNMENTS 
       (ASSIGNMENT_ID, STUDENT_ID, PATIENT_UID, ASSIGNED_DATE, STATUS)
       VALUES (:id, :sid, :pid, SYSTIMESTAMP, 'ACTIVE')`,
      { id: assignmentId, sid: student_id, pid: patient_id },
      { autoCommit: true }
    );

    res.status(201).json({
      message: 'تم تعيين المريض للطالب بنجاح',
      assignment_id: assignmentId
    });

  } catch (error) {
    console.error('Error assigning patient:', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (connection) await connection.close();
  }
});


// 79. Delete patient assignment
app.delete('/remove_patient_assignment/:patientId', auth, async (req, res) => {
  const { patientId } = req.params;

  let connection;
  try {
    connection = await getConnection();

    const result = await connection.execute(
      `DELETE FROM STUDENT_ASSIGNMENTS 
       WHERE PATIENT_UID = :pid AND STATUS = 'ACTIVE'`,
      { pid: patientId },
      { autoCommit: true }
    );

    // رجّع نجاح حتى لو ما في تعيينات
    return res.json({
      message: result.rowsAffected > 0 
        ? 'تم حذف التعيين بنجاح'
        : 'لا يوجد تعيينات لهذا المريض، ولا حاجة للحذف',
      rowsAffected: result.rowsAffected
    });

  } catch (error) {
    console.error('Error deleting assignment:', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (connection) await connection.close();
  }
});



// 80. Clear all assignments
app.delete('/clear_all_assignments', auth, async (req, res) => {
  let connection;
  try {
    connection = await getConnection();

    const result = await connection.execute(
      `DELETE FROM STUDENT_ASSIGNMENTS WHERE STATUS = 'ACTIVE'`,
      [],
      { autoCommit: true }
    );

    res.json({
      message: 'تم حذف جميع التعيينات',
      rowsAffected: result.rowsAffected
    });

  } catch (error) {
    console.error('Error clearing assignments:', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (connection) await connection.close();
  }
});


// 81. Get students assigned to a patient
app.get('/patient_assignments/:patientId', async (req, res) => {
  const { patientId } = req.params;

  let connection;
  try {
    connection = await getConnection();

    const result = await connection.execute(
      `SELECT sa.*, u.FULL_NAME,
              s.STUDENT_UNIVERSITY_ID
       FROM STUDENT_ASSIGNMENTS sa
       LEFT JOIN USERS u ON sa.STUDENT_ID = u.USER_ID
       LEFT JOIN STUDENTS s ON sa.STUDENT_ID = s.USER_ID
       WHERE sa.PATIENT_UID = :pid AND sa.STATUS = 'ACTIVE'`,
      { pid: patientId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    res.json(result.rows);

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (connection) await connection.close();
  }
});

// 82. Delete specific assignment
app.delete('/remove_specific_assignment/:patientId/:studentId', auth, async (req, res) => {
  const { patientId, studentId } = req.params;

  let connection;
  try {
    connection = await getConnection();

    const result = await connection.execute(
      `DELETE FROM STUDENT_ASSIGNMENTS
       WHERE PATIENT_UID = :pid AND STUDENT_ID = :sid AND STATUS = 'ACTIVE'`,
      { pid: patientId, sid: studentId },
      { autoCommit: true }
    );

    if (!result.rowsAffected) {
      return res.status(404).json({ error: 'لم يتم العثور على التعيين' });
    }

    res.json({
      message: 'تم حذف التعيين بنجاح',
      rowsAffected: result.rowsAffected
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (connection) await connection.close();
  }
});


// GET /xray_custom_report - التأكد من أنه شغال
app.get('/xray_custom_report', async (req, res) => {
  let connection;
  try {
    const { startDate, endDate } = req.query;
    console.log('📅 جاري جلب التقرير المخصص: من ${startDate} إلى ${endDate}');
    
connection = await getConnection();
    
    const query = `
      SELECT 
        XRAY_TYPE,
        CLINIC,
        STUDENT_YEAR,
        COUNT(*) as COUNT
      FROM XRAY_REQUESTS 
      WHERE TRUNC(CREATED_AT) BETWEEN TO_DATE(:startDate, 'YYYY-MM-DD') AND TO_DATE(:endDate, 'YYYY-MM-DD')
        AND STATUS = 'completed'
      GROUP BY XRAY_TYPE, CLINIC, STUDENT_YEAR
      ORDER BY XRAY_TYPE, CLINIC, STUDENT_YEAR
    `;
    
    const result = await connection.execute(query, { startDate, endDate });
    console.log('📊 عدد النتائج: ${result.rows.length}');
    
    const transformedData = {};
    result.rows.forEach(row => {
      const [xrayType, clinic, studentYear, count] = row;
      const yearKey = `year_${studentYear}`;
      
      if (!transformedData[xrayType]) {
        transformedData[xrayType] = {};
      }
      if (!transformedData[xrayType][clinic]) {
        transformedData[xrayType][clinic] = {
          'year_4': 0,
          'year_5': 0
        };
      }
      
      transformedData[xrayType][clinic][yearKey] = count;
    });
    
    res.json(transformedData);
    
  } catch (error) {
    console.error('❌ Error fetching custom report:', error);
    res.json({});
  } finally {
    if (connection) await connection.close();
  }
});

// 83. Get student examinations - NUCLEAR CIRCULAR REFERENCE FIX
app.get("/student-examinations/:studentId", async (req, res) => {
  let connection;
  try {
    const { studentId } = req.params;
    console.log('📋 Fetching examinations for student:', studentId);

connection = await getConnection();

    const query = `
      SELECT 
        e.EXAM_ID,
        e.PATIENT_UID,
        e.DOCTOR_ID,
        TO_CHAR(e.EXAM_DATE, 'YYYY-MM-DD HH24:MI:SS') as EXAM_DATE,
        e.NOTES,
        e.EXAM_DATA,
        e.SCREENING_DATA,
        e.DENTAL_FORM_DATA,
        p.FIRSTNAME,
        p.FATHERNAME,
        p.GRANDFATHERNAME,
        p.FAMILYNAME,
        p.IDNUMBER,
        TO_CHAR(p.BIRTHDATE, 'YYYY-MM-DD') as BIRTHDATE,
        p.GENDER,
        p.PHONE,
        p.MEDICAL_RECORD_NO,
        p.IDIMAGE,
        p.IQRAR,
        p.IMAGE,
        u.FULL_NAME as DOCTOR_NAME
      FROM EXAMINATIONS e
      INNER JOIN STUDENT_ASSIGNMENTS sa ON e.PATIENT_UID = sa.PATIENT_UID
      INNER JOIN PATIENTS p ON e.PATIENT_UID = p.PATIENT_UID
      LEFT JOIN USERS u ON e.DOCTOR_ID = u.USER_ID
      WHERE sa.STUDENT_ID = :studentId
      AND sa.STATUS = 'ACTIVE'
      ORDER BY e.EXAM_DATE DESC
    `;

    const result = await connection.execute(
      query,
      { studentId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    console.log(`✅ Found ${result.rows.length} examinations for student ${studentId}`);

    // 🔥 NUCLEAR APPROACH: Convert Oracle result to plain array immediately
    const safeConvertOracleResult = (oracleResult) => {
      const plainRows = [];
      
      for (let i = 0; i < oracleResult.rows.length; i++) {
        const oracleRow = oracleResult.rows[i];
        const plainRow = {};
        
        // استخراج كل خاصية بشكل منفصل
        Object.keys(oracleRow).forEach(key => {
          const value = oracleRow[key];
          
          // تجاهل تماماً أي كائنات Oracle المعقدة
          if (value === null || value === undefined) {
            plainRow[key] = value;
          } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            plainRow[key] = value;
          } else {
            // لأي كائن آخر، حوله إلى سلسلة أو تجاهله
            try {
              plainRow[key] = value.toString();
            } catch {
              plainRow[key] = null;
            }
          }
        });
        
        plainRows.push(plainRow);
      }
      
      return plainRows;
    };

    // تحويل النتيجة إلى مصفوفة عادية فوراً
    const plainRows = safeConvertOracleResult(result);
    console.log('✅ Converted Oracle result to plain array');

    // معالجة الصفوف العادية
    const examinations = plainRows.map(row => {
      const examination = {
        EXAM_ID: row.EXAM_ID,
        PATIENT_UID: row.PATIENT_UID,
        DOCTOR_ID: row.DOCTOR_ID,
        EXAM_DATE: row.EXAM_DATE,
        NOTES: row.NOTES,
        EXAM_DATA: {},
        SCREENING_DATA: {},
        DENTAL_FORM_DATA: {},
        PATIENT_DATA: {
          PATIENT_UID: row.PATIENT_UID,
          FIRSTNAME: row.FIRSTNAME,
          FATHERNAME: row.FATHERNAME,
          GRANDFATHERNAME: row.GRANDFATHERNAME,
          FAMILYNAME: row.FAMILYNAME,
          IDNUMBER: row.IDNUMBER,
          BIRTHDATE: row.BIRTHDATE,
          GENDER: row.GENDER,
          PHONE: row.PHONE,
          MEDICAL_RECORD_NO: row.MEDICAL_RECORD_NO,
          IDIMAGE: row.IDIMAGE,
          IQRAR: row.IQRAR,
          IMAGE: row.IMAGE
        },
        DOCTOR_DATA: {
          FULL_NAME: row.DOCTOR_NAME
        }
      };

      // معالجة بيانات JSON من CLOB
      try {
        if (row.EXAM_DATA && typeof row.EXAM_DATA === 'string' && row.EXAM_DATA.trim()) {
          examination.EXAM_DATA = JSON.parse(row.EXAM_DATA);
        }
      } catch (e) {
        console.log('⚠️ Could not parse EXAM_DATA for exam', row.EXAM_ID, e.message);
      }

      try {
        if (row.SCREENING_DATA && typeof row.SCREENING_DATA === 'string' && row.SCREENING_DATA.trim()) {
          examination.SCREENING_DATA = JSON.parse(row.SCREENING_DATA);
        }
      } catch (e) {
        console.log('⚠️ Could not parse SCREENING_DATA for exam', row.EXAM_ID, e.message);
      }

      try {
        if (row.DENTAL_FORM_DATA && typeof row.DENTAL_FORM_DATA === 'string' && row.DENTAL_FORM_DATA.trim()) {
          examination.DENTAL_FORM_DATA = JSON.parse(row.DENTAL_FORM_DATA);
        }
      } catch (e) {
        console.log('⚠️ Could not parse DENTAL_FORM_DATA for exam', row.EXAM_ID, e.message);
      }

      return examination;
    });

    console.log('✅ Successfully processed all examinations');

    // 🔥 استخدام res.send() مع JSON.stringify مباشرة
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(examinations, null, 2));

  } catch (error) {
    console.error('❌ Error fetching student examinations:', error);
    
    // 🔥 إرسال خطأ كـ JSON نصي مباشرة
    res.setHeader('Content-Type', 'application/json');
    res.status(500).send(JSON.stringify({
      error: 'Failed to fetch student examinations',
      details: error.message
    }));
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (error) {
        console.error('Error closing connection:', error);
      }
    }
  }
});

// 84. Get all patients with full data including images
app.get("/all-patients", async (req, res) => {
  let connection;
  try {
connection = await getConnection();

    const result = await connection.execute(
      `SELECT 
        PATIENT_UID,
        FIRSTNAME,
        FATHERNAME,
        GRANDFATHERNAME,
        FAMILYNAME,
        IDNUMBER,
        BIRTHDATE,
        GENDER,
        ADDRESS,
        PHONE,
        CREATEDAT,
        STATUS,
        IQRAR,
        IMAGE,
        IDIMAGE,
        APPROVED_DATE,
        APPROVED_BY,
        MEDICAL_RECORD_NO
       FROM PATIENTS 
       ORDER BY CREATEDAT DESC`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const patients = result.rows.map(patient => ({
      id: patient.PATIENT_UID,
      patient_uid: patient.PATIENT_UID,
      firstName: patient.FIRSTNAME || '',
      fatherName: patient.FATHERNAME || '',
      grandfatherName: patient.GRANDFATHERNAME || '',
      familyName: patient.FAMILYNAME || '',
      idNumber: patient.IDNUMBER || '',
      birthDate: patient.BIRTHDATE,
      gender: patient.GENDER || '',
      address: patient.ADDRESS || '',
      phone: patient.PHONE || '',
      createdAt: patient.CREATEDAT,
      status: patient.STATUS || 'active',
      iqrar: patient.IQRAR || '',
      image: patient.IMAGE || '',
      idImage: patient.IDIMAGE || '',
      approvedDate: patient.APPROVED_DATE,
      approvedBy: patient.APPROVED_BY || '',
      medicalRecordNo: patient.MEDICAL_RECORD_NO || ''
    }));

    res.status(200).json(patients);
  } catch (err) {
    console.error("❌ Error fetching all patients:", err);
    res.status(500).json({ 
      message: "❌ Error fetching patients", 
      error: err.message 
    });
  } finally {
    if (connection) await connection.close();
  }
});

// 85. Update patient ID image
app.put("/patients/:patientId/id-image", async (req, res) => {
  const { patientId } = req.params;
  const { idImage } = req.body;

  if (!idImage) {
    return res.status(400).json({ message: "❌ ID image is required" });
  }

  let connection;
  try {
connection = await getConnection();

    const result = await connection.execute(
      `UPDATE PATIENTS SET IDIMAGE = :idImage WHERE PATIENT_UID = :patientId`,
      { idImage, patientId },
      { autoCommit: true }
    );

    if (result.rowsAffected === 0) {
      return res.status(404).json({ message: "❌ Patient not found" });
    }

    res.status(200).json({ 
      message: "✅ ID image updated successfully",
      patientId: patientId
    });
  } catch (err) {
    console.error("❌ Error updating ID image:", err);
    res.status(500).json({ 
      message: "❌ Error updating ID image", 
      error: err.message 
    });
  } finally {
    if (connection) await connection.close();
  }
});

// 86. Update patient IQRAR image
app.put("/patients/:patientId/iqrar", async (req, res) => {
  const { patientId } = req.params;
  const { iqrar } = req.body;

  if (!iqrar) {
    return res.status(400).json({ message: "❌ IQRAR image is required" });
  }

  let connection;
  try {
connection = await getConnection();

    const result = await connection.execute(
      `UPDATE PATIENTS SET IQRAR = :iqrar WHERE PATIENT_UID = :patientId`,
      { iqrar, patientId },
      { autoCommit: true }
    );

    if (result.rowsAffected === 0) {
      return res.status(404).json({ message: "❌ Patient not found" });
    }

    res.status(200).json({ 
      message: "✅ IQRAR image updated successfully",
      patientId: patientId
    });
  } catch (err) {
    console.error("❌ Error updating IQRAR image:", err);
    res.status(500).json({ 
      message: "❌ Error updating IQRAR image", 
      error: err.message 
    });
  } finally {
    if (connection) await connection.close();
  }
});

// 87. Get full patient details by ID
app.get("/patients-full/:id", async (req, res) => {
  const { id } = req.params;
  let connection;
  try {
connection = await getConnection();

    const result = await connection.execute(
      `SELECT 
        PATIENT_UID,
        FIRSTNAME,
        FATHERNAME, 
        GRANDFATHERNAME,
        FAMILYNAME,
        IDNUMBER,
        BIRTHDATE,
        GENDER,
        ADDRESS,
        PHONE,
        IQRAR,
        IMAGE,
        IDIMAGE,
        MEDICAL_RECORD_NO,
        STATUS,
        CREATEDAT,
        APPROVED_DATE,
        APPROVED_BY
       FROM PATIENTS 
       WHERE PATIENT_UID = :id`,
      { id },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (!result.rows || result.rows.length === 0) {
      return res.status(404).json({ 
        message: "❌ Patient not found",
        patientId: id 
      });
    }

    const patient = result.rows[0];
    
    // حساب العمر من تاريخ الميلاد
    let age = null;
    if (patient.BIRTHDATE) {
      const birthDate = new Date(patient.BIRTHDATE);
      const today = new Date();
      age = today.getFullYear() - birthDate.getFullYear();
      const monthDiff = today.getMonth() - birthDate.getMonth();
      if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
        age--;
      }
    }

    const patientData = {
      id: patient.PATIENT_UID,
      patient_uid: patient.PATIENT_UID,
      firstName: patient.FIRSTNAME || '',
      fatherName: patient.FATHERNAME || '',
      grandfatherName: patient.GRANDFATHERNAME || '',
      familyName: patient.FAMILYNAME || '',
      fullName: `${patient.FIRSTNAME || ''} ${patient.FATHERNAME || ''} ${patient.GRANDFATHERNAME || ''} ${patient.FAMILYNAME || ''}`.trim(),
      idNumber: patient.IDNUMBER || '',
      birthDate: patient.BIRTHDATE,
      age: age,
      gender: patient.GENDER || '',
      address: patient.ADDRESS || '',
      phone: patient.PHONE || '',
      iqrar: patient.IQRAR || '',
      image: patient.IMAGE || '',
      idImage: patient.IDIMAGE || '',
      medicalRecordNo: patient.MEDICAL_RECORD_NO || '',
      status: patient.STATUS || 'active',
      createdAt: patient.CREATEDAT,
      approvedDate: patient.APPROVED_DATE,
      approvedBy: patient.APPROVED_BY || ''
    };

    res.status(200).json(patientData);
  } catch (err) {
    console.error("❌ Error fetching full patient details:", err);
    res.status(500).json({ 
      message: "❌ Error fetching patient details", 
      error: err.message 
    });
  } finally {
    if (connection) await connection.close();
  }
});


// 88. Check if ID exists in PATIENTS table
app.get("/patients/check-id/:idNumber", async (req, res) => {
  const { idNumber } = req.params;

  let connection;
  try {
    connection = await getConnection();

    const result = await connection.execute(
      `SELECT COUNT(*) AS COUNT 
       FROM PATIENTS 
       WHERE IDNUMBER = :idNumber`,
      { idNumber: Number(idNumber) },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const exists = result.rows[0].COUNT > 0;

    return res.status(200).json({
      exists,
      message: exists ? "رقم الهوية مسجل مسبقاً" : "رقم الهوية متاح"
    });

  } catch (err) {
    console.error("❌ Error checking ID:", err);
    return res.status(500).json({
      message: "❌ Error checking ID",
      error: err.message
    });
  } finally {
    if (connection) await connection.close();
  }
});

// 89. Add new patient
app.post("/patients", async (req, res) => {
  const body = typeof req.body === "string" ? (() => {
    try { return JSON.parse(req.body); } catch { return {}; }
  })() : req.body || {};

  const {
    firstName,
    fatherName,
    grandfatherName,
    familyName,
    idNumber,
    birthDate,
    gender,
    address,
    phone,
    idImage,
    agreementImage
  } = body;

  // Required fields
  if (!firstName || !familyName || !idNumber) {
    return res.status(400).json({
      message: "❌ Missing required fields",
      required: ["firstName", "familyName", "idNumber"]
    });
  }

  let connection;
  try {
    connection = await getConnection();

    // Check existing ID
    const idCheck = await connection.execute(
      `SELECT COUNT(*) AS COUNT 
       FROM PATIENTS 
       WHERE IDNUMBER = :idNumber`,
      { idNumber: Number(idNumber) },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (idCheck.rows[0].COUNT > 0) {
      return res.status(409).json({
        message: "❌ رقم الهوية مسجل مسبقاً",
        idNumber
      });
    }

    // patient_uid = idNumber
    const patientUid = String(idNumber);

    // Medical record number
    const medicalRecordNo = `MR${Date.now().toString().slice(-6)}`;

    // Birthdate formatting
    let birthDateValue = "2000-01-01";
    if (birthDate) {
      const parsed = new Date(birthDate);
      if (!isNaN(parsed)) birthDateValue = parsed.toISOString().split("T")[0];
    }

    // Gender normalization
    const genderValue =
      ["male", "ذكر"].includes(gender) ? "MALE" :
      ["female", "أنثى"].includes(gender) ? "FEMALE" :
      "MALE";

    const sql = `
      INSERT INTO PATIENTS (
        PATIENT_UID, FIRSTNAME, FATHERNAME, GRANDFATHERNAME, FAMILYNAME,
        IDNUMBER, BIRTHDATE, GENDER, ADDRESS, PHONE,
        IQRAR, IDIMAGE, MEDICAL_RECORD_NO, STATUS, CREATEDAT,
        APPROVED_DATE, APPROVED_BY
      ) VALUES (
        :patientUid, :firstName, :fatherName, :grandfatherName, :familyName,
        :idNumber, TO_DATE(:birthDate, 'YYYY-MM-DD'), :gender, :address, :phone,
        :iqrar, :idImage, :medicalRecordNo, 'active', SYSDATE,
        SYSDATE, :approvedBy
      )
    `;

    const bind = {
      patientUid,
      firstName: firstName.trim(),
      fatherName: fatherName?.trim() || "",
      grandfatherName: grandfatherName?.trim() || "",
      familyName: familyName.trim(),
      idNumber: Number(idNumber),
      birthDate: birthDateValue,
      gender: genderValue,
      address: address?.trim() || "غير محدد",
      phone: phone?.replace(/\D/g, "") || "0000000000",
      iqrar: agreementImage || "",
      idImage: idImage || "",
      medicalRecordNo,
      approvedBy: "secretary"
    };

    const result = await connection.execute(sql, bind, { autoCommit: true });

    return res.status(201).json({
      message: "✅ تمت إضافة المريض بنجاح",
      patientUid,
      medicalRecordNo,
      rowsAffected: result.rowsAffected
    });

  } catch (err) {
    console.error("❌ Error adding patient:", err);

    const errorMap = {
      1: "❌ Patient already exists with this ID number",
      2290: "❌ Data validation error",
      1861: "❌ Invalid date format"
    };

    return res.status(500).json({
      message: errorMap[err.errorNum] || "❌ Error adding patient",
      error: err.message,
      errorCode: err.errorNum
    });

  } finally {
    if (connection) await connection.close();
  }
});


// 90. Update patient data
app.put("/patients/:patientId", async (req, res) => {
  const { patientId } = req.params;

  const body = typeof req.body === "string" ? (() => {
    try { return JSON.parse(req.body); } catch { return {}; }
  })() : req.body || {};

  if (!body || Object.keys(body).length === 0) {
    return res.status(400).json({ message: "❌ No data provided for update" });
  }

  let connection;
  try {
    connection = await getConnection();

    const allowedFields = [
      "firstName", "fatherName", "grandfatherName", "familyName",
      "birthDate", "gender", "address", "phone", "idImage", "iqrar"
    ];

    const set = [];
    const bind = { patientId };

    for (const key of allowedFields) {
      if (body[key] !== undefined) {
        const dbField =
          key === "iqrar" ? "IQRAR" :
          key === "idImage" ? "IDIMAGE" :
          key.toUpperCase();

        if (key === "birthDate") {
          const formatted = body.birthDate?.split("T")[0];
          set.push(`${dbField} = TO_DATE(:${key}, 'YYYY-MM-DD')`);
          bind[key] = formatted;
        } else {
          set.push(`${dbField} = :${key}`);
          bind[key] = body[key];
        }
      }
    }

    if (set.length === 0) {
      return res.status(400).json({ message: "❌ No valid fields to update" });
    }

    const sql = `UPDATE PATIENTS SET ${set.join(", ")} WHERE PATIENT_UID = :patientId`;

    const result = await connection.execute(sql, bind, { autoCommit: true });

    if (result.rowsAffected === 0) {
      return res.status(404).json({ message: "❌ Patient not found" });
    }

    return res.status(200).json({
      message: "✅ Patient data updated successfully",
      patientId,
      updatedFields: set
    });

  } catch (err) {
    console.error("❌ Error updating patient:", err);
    return res.status(500).json({
      message: "❌ Error updating patient",
      error: err.message
    });

  } finally {
    if (connection) await connection.close();
  }
});

// -----------------------------
// Start Oracle Pool THEN Server
// -----------------------------
async function startServer() {
  try {
    await initOraclePool();
    await ensureXrayImagesTable();

    app.listen(PORT, () => {
      console.log(`🚀 Dynamic API Server running on http://localhost:${PORT}`);
      console.log(`📋 Available endpoints:`);

      const endpoints = [
        "GET  /all-examinations-full",
        "GET  /all-examinations",
        "GET  /examinations/:patientId",
        "POST /examinations",
        "POST /screening",
        "GET  /students",
        "GET  /patients",
        "GET  /student_assignments/:studentId",
        "POST /student_assignments",
        "PUT  /patients/:patientId/status",
        "PUT  /appointments/update_examined/:patientId",
        "GET  /check-patient/:patientUid",
        "GET  /check-doctor/:id",
        "GET  /patients/by-appointment-id/:idnumber",
        "GET  /patients/:id",
        "GET  /pendingUsers",
        "POST /pendingUsers",
        "POST /approveUser",
        "POST /rejectUser",
        "POST /updateUser",
        "GET  /rejectedUsers",
        "GET  /users",
        "POST /users",
        "GET  /users/:id",
        "PUT  /users/:id",
        "DELETE /users/:id",
        "POST /login",
        "GET  /doctors",
        "GET  /doctors/:id",
        "GET  /doctors/:id/type",
        "PUT  /doctors/:id/type",
        "PUT  /doctors/:id/features",
        "PUT  /doctors/batch/features",
        "PUT  /doctors/batch/features-simple",
        "GET  /appointments",
        "POST /appointments",
        "GET  /appointments/count",
        "GET  /waitingList",
        "POST /waitingList",
        "DELETE /waitingList/:id",
        "GET  /patientExams",
        "POST /patientExams",
        "GET  /patients",
        "GET  /students/:userId",
        "GET  /bookingSettings",
        "PUT  /bookingSettings",
        "POST /add-test-patient",
        "GET  /all-examinations-simple",
        "GET  /examination-full/:examId",
        "POST /add-test-examination"
      ];

      endpoints.forEach(ep => console.log(`   ${ep}`));
    });
  } catch (err) {
    console.error("❌ Oracle Pool failed to start:", err);
    process.exit(1); // ايقاف السيرفر إذا البوول ما اشتغل
  }
}

startServer();
