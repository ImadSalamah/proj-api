const oracledb = require("oracledb");
const path = require("path");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const cors = require("cors");
const helmet = require("helmet");
const bcrypt = require('bcrypt');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const express = require('express');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;


oracledb.initOracleClient({
  libDir: "/Users/macbook/instantclient_19_8"
});


const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  connectString: process.env.DB_CONNECTION_STRING // dcsaauj_high
};



// 🔥 دالة الاتصال
async function getConnection() {
  return await oracledb.getConnection(dbConfig);
}

// 🔥 Cloudinary Configuration
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Middleware
app.use(helmet());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
});
app.use(limiter);

app.use(cors({
  origin: '*',
}));

const upload = multer({ dest: 'uploads/' });

// ✅ JWT Auth Middleware
function auth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ message: "Access denied, token missing" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const verified = jwt.verify(token, process.env.JWT_SECRET || "fallback_secret");
    req.user = verified;
    next();
  } catch (err) {
    return res.status(403).json({ message: "Invalid or expired token" });
  }
}

// ✅ Middleware ثاني للتحقق من صلاحيات الأدمن
function isAdmin(req, res, next) {
  if (req.user && req.user.role === "admin") {
    next();
  } else {
    return res.status(403).json({ message: "Access denied, admin only" });
  }
}

// 🔥 Helper Functions
function cleanNotesField(notes) {
  if (!notes) return '';
  if (typeof notes === 'string') {
    return notes.replace(/[^\w\s\u0600-\u06FF.,!?\-@#$%^&*()_+=]/g, '').substring(0, 1000);
  }
  return String(notes).substring(0, 1000);
}

async function extractClobText(clobData) {
  if (!clobData) return null;
  try {
    if (typeof clobData === 'string') return clobData;
    if (typeof clobData === 'object' && clobData !== null) {
      if (clobData.toString && typeof clobData.toString === 'function') {
        return clobData.toString();
      }
    }
    return null;
  } catch (error) {
    return null;
  }
}

function parseDoubleEncodedJSON(jsonString) {
  if (!jsonString || typeof jsonString !== 'string') return {};
  try {
    const cleanedString = jsonString.trim();
    if (!cleanedString) return {};
    if (cleanedString.startsWith('{') && cleanedString.endsWith('}')) {
      return JSON.parse(cleanedString);
    }
    if (cleanedString.includes('{"') && cleanedString.includes('}')) {
      const startIndex = cleanedString.indexOf('{');
      const endIndex = cleanedString.lastIndexOf('}') + 1;
      if (startIndex !== -1 && endIndex !== -1) {
        const potentialJson = cleanedString.substring(startIndex, endIndex);
        return JSON.parse(potentialJson);
      }
    }
    return {};
  } catch (error) {
    return {};
  }
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

// ===============================
// 🚀 START OF ENDPOINTS - EXACTLY AS ORIGINAL
// ===============================

// =====================================================
//  📥 Import Dental Students from Excel (Standalone)
//  POST /import-dental-students
// =====================================================
const XLSX = require("xlsx");
const uploadExcel = multer({ dest: "uploads/" }); 

app.post("/import-dental-students", uploadExcel.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "❌ Please upload an Excel file." });
  }

  let connection;

  try {
    // 1) اقرأ ملف Excel
    const workbook = XLSX.readFile(req.file.path);
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(worksheet);

    connection = await oracledb.getConnection(dbConfig);

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
          `${FIRST_NAME} ${FATHER_NAME} ${GRANDFATHER_NAME} ${FAMILY_NAME}`;

        const EMAIL = row.EMAIL || `${row.STUDENT_ID}@student.aaup.edu`;
        const USERNAME = row.USERNAME || row.STUDENT_ID;
        const ROLE = "dental_student";
        const studyYear = extractStudyYear(row);
        const studentUniversityId =
          row.STUDENT_ID ||
          row.STUDENT_UNIVERSITY_ID ||
          row.studentUniversityId ||
          row.student_id;

        // =====================================================
        // 🔐 NEW: Password logic (exactly as you requested)
        // =====================================================
        let plainPassword;

        if (row.password) {
          // إذا في عمود اسمه password
          plainPassword = row.password;

        } else if (row.PASSWORD_HASH) {
          // إذا في عمود PASSWORD_HASH نتعامل معها كباسورد عادية
          plainPassword = row.PASSWORD_HASH;

        } else {
          // باسورد تلقائي إذا ولا واحد موجود
          plainPassword =
            `${FIRST_NAME.slice(0, 3)}${String(row.STUDENT_ID).slice(-4)}`.toLowerCase();
        }

        // اعمل hashing لأي خيار أعلاه
        const PASSWORD_HASH = await bcrypt.hash(plainPassword, 10);

        // =====================================================
        // INSERT INTO USERS
        // =====================================================
        await connection.execute(
          `
          INSERT INTO USERS (
            USER_ID, FIRST_NAME, FATHER_NAME, GRANDFATHER_NAME, FAMILY_NAME,
            FULL_NAME, CREATED_AT, EMAIL, IS_ACTIVE, ROLE, USERNAME, PASSWORD_HASH
          ) VALUES (
            :USER_ID, :FIRST_NAME, :FATHER_NAME, :GRANDFATHER_NAME, :FAMILY_NAME,
            :FULL_NAME, SYSDATE, :EMAIL, 1, :ROLE, :USERNAME, :PASSWORD_HASH
          )
        `,
          {
            USER_ID,
            FIRST_NAME,
            FATHER_NAME,
            GRANDFATHER_NAME,
            FAMILY_NAME,
            FULL_NAME,
            EMAIL,
            ROLE,
            USERNAME,
            PASSWORD_HASH,
          }
        );

        // =====================================================
        // INSERT INTO STUDENTS (if STUDENT_ID exists)
        // =====================================================
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
  }
});


app.get('/test-db', async (req, res) => {
  try {
    const conn = await getConnection();
    const result = await conn.execute(`SELECT USERNAME, ROLE FROM USERS`);
    await conn.close();
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send('Database connection error');
  }
});


// 1. Save examination data
app.post("/examinations", async (req, res) => {
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
    connection = await oracledb.getConnection(dbConfig);

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

    // 🟢 هنا أهم نقطة: لا تعمل JSON.stringify للداتا القادمة من Flutter
    // لأنها String جاهزة

    const sql = `
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

    const bindValues = {
      exam_id,
      patient_uid,
      doctor_id,
      exam_data: exam_data ?? null,
      screening_data: screening_data ?? null,
      dental_form_data: dental_form_data ?? null,
      notes: notes ?? null
    };

    const result = await connection.execute(sql, bindValues, { autoCommit: true });

    res.status(201).json({
      message: "✅ Examination saved successfully",
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
    connection = await oracledb.getConnection(dbConfig);

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
    connection = await oracledb.getConnection(dbConfig);
    
    // ✅ استعلام مع معالجة الـ LOB
    const result = await connection.execute(
      `SELECT DOCTOR_ID, ALLOWED_FEATURES, DOCTOR_TYPE, IS_ACTIVE 
       FROM doctors 
       WHERE DOCTOR_ID = :id`,
      [id],
      { 
        outFormat: oracledb.OUT_FORMAT_OBJECT,
        // ✅ إضافة هذا الخيار لمعالجة LOB
        fetchInfo: {
          "ALLOWED_FEATURES": { type: oracledb.STRING }
        }
      }
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Doctor not found' });
    }
    
    const doctor = result.rows[0];
    
    // ✅ معالجة ALLOWED_FEATURES إذا كانت LOB
    let allowedFeatures = [];
    if (doctor.ALLOWED_FEATURES) {
      try {
        // إذا كانت LOB object، حولها إلى string أولاً
        const featuresString = typeof doctor.ALLOWED_FEATURES === 'object' 
          ? await doctor.ALLOWED_FEATURES.getData() 
          : doctor.ALLOWED_FEATURES.toString();
        
        // ثم حول الـ string إلى JSON
        if (featuresString && featuresString.trim() !== '') {
          allowedFeatures = JSON.parse(featuresString);
        }
      } catch (e) {
        console.error('❌ Error parsing ALLOWED_FEATURES:', e);
        // إذا فشل التحويل، استخدم array فارغ
        allowedFeatures = [];
      }
    }
    
    // ✅ إضافة allowedFeatures معالج إلى response
    const responseData = {
      message: '✅ Doctor data retrieved successfully',
      doctor: {
        DOCTOR_ID: doctor.DOCTOR_ID,
        ALLOWED_FEATURES: allowedFeatures, // ✅ هذا هو المهم
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
// 3. Get all students - NEEDS UPDATE
app.get("/students", async (req, res) => {
  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);

    const result = await connection.execute(
      `SELECT 
        u.USER_ID as id,
        u.FIRST_NAME as firstName,
        u.FATHER_NAME as fatherName, 
        u.GRANDFATHER_NAME as grandfatherName,
        u.FAMILY_NAME as familyName,
        u.FULL_NAME as FULL_NAME,
        u.USERNAME as username,
        u.EMAIL as email,
        u.ROLE as role,
        u.IS_ACTIVE as isActive,
        u.CREATED_AT as createdAt,
        s.STUDENT_UNIVERSITY_ID as universityId,
        s.STUDY_YEAR as studyYear
       FROM USERS u
       LEFT JOIN STUDENTS s ON u.USER_ID = s.USER_ID
       WHERE u.ROLE LIKE '%student%' OR u.ROLE LIKE '%طالب%'
       ORDER BY u.FULL_NAME`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const students = result.rows.map(student => ({
      ...student,
      // إزالة الحقول التي لم تعد موجودة
      id: student.id || student.USER_ID,
      firstName: student.firstName || student.FIRST_NAME || '',
      fatherName: student.fatherName || student.FATHER_NAME || '',
      grandfatherName: student.grandfatherName || student.GRANDFATHER_NAME || '',
      familyName: student.familyName || student.FAMILY_NAME || '',
      fullName: student.fullName || student.FULL_NAME || '',
      universityId: student.universityId || student.STUDENT_UNIVERSITY_ID || '',
      studyYear: student.studyYear ?? student.STUDY_YEAR ?? null
    }));

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

// 4. Get all patients for assignment - UPDATED TO INCLUDE EXAMINED PATIENTS
app.get("/patients", async (req, res) => {
  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);

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
       ORDER BY FIRSTNAME, FAMILYNAME`,
      [],
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
    connection = await oracledb.getConnection(dbConfig);

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

//6. Save student assignments
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
    connection = await oracledb.getConnection(dbConfig);

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
        // تحقق من وجود المريض
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

        // تحقق من عدم وجود تعيين مسبق
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

        // إضافة التعيين الجديد
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

// 7 . Update patient status to EXAMINED
app.put("/patients/:patientId/status", async (req, res) => {
  const { patientId } = req.params;
  const { status } = req.body;

  if (!status) {
    return res.status(400).json({ message: "❌ Status is required" });
  }

  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);

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
    connection = await oracledb.getConnection(dbConfig);

    // هذا مثال - عدل حسب جدول المواعيد عندك
    const result = await connection.execute(
      `UPDATE APPOINTMENTS SET EXAMINED = :examined WHERE PATIENT_ID_NUMBER = :patientId`,
      { examined: examined ? 1 : 0, patientId },
      { autoCommit: true }
    );

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

// 9. Check if patient exists in PATIENTS table
app.get("/check-patient/:patientUid", async (req, res) => {
  const { patientUid } = req.params;
  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);

    const result = await connection.execute(
      `SELECT PATIENT_UID, FIRSTNAME, FAMILYNAME FROM PATIENTS WHERE PATIENT_UID = :patientUid`,
      { patientUid },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        exists: false,
        message: "❌ Patient not found in PATIENTS table" 
      });
    }

    res.status(200).json({ 
      exists: true,
      patient: result.rows[0]
    });
  } catch (err) {
    console.error("❌ Error checking patient:", err);
    res.status(500).json({ 
      message: "❌ Error checking patient", 
      error: err.message 
    });
  } finally {
    if (connection) await connection.close();
  }
});

// 10. Check doctor data endpoint
app.get("/check-doctor/:id", async (req, res) => {
  const { id } = req.params;
  let connection;
  
  try {
    connection = await oracledb.getConnection(dbConfig);
    
    // التحقق من وجود المستخدم في USERS
    const userResult = await connection.execute(
      `SELECT USER_ID, FULL_NAME, ROLE FROM USERS WHERE USER_ID = :id`,
      { id },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    // التحقق من وجود الطبيب في DOCTORS
    const doctorResult = await connection.execute(
      `SELECT d.DOCTOR_ID, d.DOCTOR_TYPE, DBMS_LOB.SUBSTR(d.ALLOWED_FEATURES, 4000, 1) as FEATURES
       FROM DOCTORS d 
       WHERE TO_CHAR(d.DOCTOR_ID) = :id`,
      { id },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    res.json({
      userExists: userResult.rows.length > 0,
      doctorExists: doctorResult.rows.length > 0,
      user: userResult.rows[0] || null,
      doctor: doctorResult.rows[0] || null,
      features: doctorResult.rows[0] ? doctorResult.rows[0].FEATURES : null
    });

  } catch (err) {
    console.error('❌ Error in check-doctor:', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

// 11 . NEW ENDPOINT: البحث عن المريض باستخدام IDNUMBER من جدول المواعيد
app.get("/patients/by-appointment-id/:idnumber", async (req, res) => {
  const { idnumber } = req.params;
  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);

    const result = await connection.execute(
      `SELECT * FROM PATIENTS WHERE IDNUMBER = :idnumber`,
      { idnumber: parseInt(idnumber) },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (!result.rows || result.rows.length === 0) {
      return res.status(404).json({ 
        message: "❌ Patient not found with this ID number",
        idnumber: idnumber 
      });
    }

    const patient = result.rows[0];
    
    res.status(200).json(patient);
  } catch (err) {
    console.error("❌ Error fetching patient by ID number:", err);
    res.status(500).json({ 
      message: "❌ Error fetching patient", 
      error: err.message 
    });
  } finally {
    if (connection) await connection.close();
  }
});

// 12. Get all pending users
app.get("/pendingUsers", async (req, res) => {
  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);

    const result = await connection.execute(
      `SELECT USER_UID, FIRSTNAME, FATHERNAME, GRANDFATHERNAME, FAMILYNAME, IDNUMBER, BIRTHDATE, GENDER, ADDRESS, PHONE, CREATEDAT, STATUS, ROLE, ISACTIVE, STUDENTID, IQRAR, IMAGE, IDIMAGE FROM PENDINGUSERS WHERE STATUS = 'pending' OR STATUS IS NULL`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const users = result.rows.map(user => ({
      ...user,
      FIRSTNAME: user.FIRSTNAME || 'Unknown',
      IMAGE: user.IMAGE || 'https://example.com/default-image.png',
      IDIMAGE: user.IDIMAGE || 'https://example.com/default-idimage.png',
    }));

    res.status(200).json(users);
  } catch (err) {
    console.error("❌ Error fetching pending users:", err);
    res.status(500).json({ message: "❌ Error fetching pending users", error: err.message });
  } finally {
    if (connection) {
      await connection.close();
    }
  }
});

// 13. Add new pending user - FIXED DATE FORMAT
app.post("/pendingUsers", async (req, res) => {
  let parsedBody;
  if (!req.body) {
    parsedBody = {};
  } else if (typeof req.body === 'string') {
    try {
      parsedBody = JSON.parse(req.body);
    } catch (e) {
      return res.status(400).json({ message: 'Invalid JSON body' });
    }
  } else {
    parsedBody = req.body;
  }

  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);

    const sql = `INSERT INTO PENDINGUSERS 
      (USER_UID, FIRSTNAME, FATHERNAME, GRANDFATHERNAME, FAMILYNAME, IDNUMBER, BIRTHDATE, GENDER, ADDRESS, PHONE, IDIMAGE, STATUS, ROLE, ISACTIVE, STUDENTID, CREATEDAT) 
      VALUES (:1, :2, :3, :4, :5, :6, TO_DATE(:7, 'YYYY-MM-DD'), :8, :9, :10, :11, :12, :13, :14, :15, SYSDATE)`;

    let birthDateValue;
    if (parsedBody.birthDate) {
      try {
        const dateObj = new Date(parsedBody.birthDate);
        if (!isNaN(dateObj.getTime())) {
          birthDateValue = dateObj.toISOString().split('T')[0];
        } else {
          birthDateValue = '2000-01-01';
        }
      } catch (dateError) {
        birthDateValue = '2000-01-01';
      }
    } else {
      birthDateValue = '2000-01-01';
    }

    const bindValues = [
      parsedBody.uid || parsedBody.authUid || ('user_' + Date.now()),
      parsedBody.firstName || '',
      parsedBody.fatherName || '',
      parsedBody.grandfatherName || '',
      parsedBody.familyName || '',
      isNaN(parsedBody.idNumber) ? 0 : parseInt(parsedBody.idNumber, 10),
      birthDateValue,
      parsedBody.gender || '',
      parsedBody.address || '',
      parsedBody.phone || '',
      parsedBody.idImage || '',
      'pending',
      'patient',
      0,
      parsedBody.studentId != null && parsedBody.studentId !== '' ? parsedBody.studentId : 'unknown_student_id'
    ];

    const result = await connection.execute(sql, bindValues, { autoCommit: true });
    res.status(201).json({ message: "✅ Pending user added successfully", rowsAffected: result.rowsAffected });
    
  } catch (err) {
    console.error('❌ Error adding pending user:', err);
    
    let errorMessage = "❌ Error adding pending user";
    if (err.errorNum === 1861) {
      errorMessage = "❌ Date format error: Please ensure birth date is in YYYY-MM-DD format";
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

// 14. Update IQRAR field for a pending user
app.put("/pendingUsers/:userId", async (req, res) => {
  const { userId } = req.params;
  const { IQRAR } = req.body;

  if (!IQRAR) {
    return res.status(400).json({ message: "❌ IQRAR field is required" });
  }

  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);

    const sql = `UPDATE PENDINGUSERS SET IQRAR = :iqrar WHERE USER_UID = :userId`;
    const bindValues = { iqrar: IQRAR, userId };

    const result = await connection.execute(sql, bindValues, { autoCommit: true });

    if (result.rowsAffected > 0) {
      res.status(200).json({ message: "✅ IQRAR updated successfully" });
    } else {
      res.status(404).json({ message: "❌ User not found" });
    }
  } catch (err) {
    console.error("❌ Error updating IQRAR:", err.message);
    res.status(500).json({ message: "❌ Error updating IQRAR", error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

// 15. Approve user and move to PATIENTS table - FIXED PATIENT_UID = IDNUMBER
app.post("/approveUser", async (req, res) => {
  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);
    
    const userData = req.body;
   const patientUid = userData.IDNUMBER?.toString() || `PATIENT_${Date.now()}`;
    const medicalRecordNo = `MR${Date.now().toString().slice(-6)}`;

    const cleanData = {
      FIRSTNAME: (userData.FIRSTNAME || 'Unknown').trim().substring(0, 50),
      FATHERNAME: (userData.FATHERNAME || '').trim().substring(0, 50),
      GRANDFATHERNAME: (userData.GRANDFATHERNAME || '').trim().substring(0, 50),
      FAMILYNAME: (userData.FAMILYNAME || '').trim().substring(0, 50),
      IDNUMBER: userData.IDNUMBER || 0,
      GENDER: (userData.GENDER || 'unknown').toUpperCase() === 'MALE' || 
              (userData.GENDER || 'unknown').toLowerCase() === 'ذكر' ? 'MALE' : 
              (userData.GENDER || 'unknown').toUpperCase() === 'FEMALE' || 
              (userData.GENDER || 'unknown').toLowerCase() === 'أنثى' ? 'FEMALE' : 'MALE',
      ADDRESS: (userData.ADDRESS || 'غير محدد').trim().substring(0, 200),
      PHONE: (userData.PHONE || '0000000000').replace(/\D/g, '').substring(0, 15),
      IQRAR: userData.IQRAR || 'https://example.com/default-iqrar.png',
      IMAGE: userData.IMAGE || 'https://example.com/default-image.png',
      IDIMAGE: userData.IDIMAGE || 'https://example.com/default-idimage.png'
    };

    let birthDateValue;
    try {
      if (userData.BIRTHDATE) {
        const dateObj = new Date(userData.BIRTHDATE);
        if (!isNaN(dateObj.getTime())) {
          birthDateValue = dateObj.toISOString().split('T')[0];
        } else {
          birthDateValue = '2000-01-01';
        }
      } else {
        birthDateValue = '2000-01-01';
      }
    } catch (dateError) {
      birthDateValue = '2000-01-01';
    }
    const idNumber = Math.abs(parseInt(cleanData.IDNUMBER)) || 1000000000;
    const insertPatientSql = `
      INSERT INTO PATIENTS (
        PATIENT_UID, FIRSTNAME, FATHERNAME, GRANDFATHERNAME, FAMILYNAME, 
        IDNUMBER, BIRTHDATE, GENDER, ADDRESS, PHONE, CREATEDAT, 
        STATUS, IQRAR, IMAGE, IDIMAGE, APPROVED_DATE, APPROVED_BY, MEDICAL_RECORD_NO
      ) VALUES (
        :patientUid, :firstName, :fatherName, :grandfatherName, :familyName, 
        :idNumber, TO_DATE(:birthDate, 'YYYY-MM-DD'), :gender, :address, :phone, SYSDATE, 
        :status, :iqrar, :image, :idImage, SYSDATE, :approvedBy, :medicalRecordNo
      )
    `;

    const patientBindValues = {
      patientUid: patientUid,
      firstName: cleanData.FIRSTNAME,
      fatherName: cleanData.FATHERNAME,
      grandfatherName: cleanData.GRANDFATHERNAME,
      familyName: cleanData.FAMILYNAME,
      idNumber: idNumber,
      birthDate: birthDateValue,
      gender: cleanData.GENDER,
      address: cleanData.ADDRESS,
      phone: cleanData.PHONE,
      status: 'active',
      iqrar: cleanData.IQRAR,
      image: cleanData.IMAGE,
      idImage: cleanData.IDIMAGE,
      approvedBy: 'system',
      medicalRecordNo: medicalRecordNo
    };

    await connection.execute(insertPatientSql, patientBindValues, { autoCommit: false });

    const deleteSql = `DELETE FROM PENDINGUSERS WHERE USER_UID = :userId`;
    await connection.execute(deleteSql, { userId: userData.USER_UID }, { autoCommit: false });

    await connection.commit();

    res.status(200).json({ 
      message: "✅ User approved and moved to patients successfully",
      patientUid: patientUid,
      medicalRecordNo: medicalRecordNo,
      idNumber: idNumber
    });

  } catch (err) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackErr) {
        console.error("❌ Rollback error:", rollbackErr);
      }
    }
    console.error("❌ Error approving user:", err);
    
    let errorMessage = "❌ Error approving user";
    if (err.errorNum === 2290) {
      errorMessage = "❌ Data validation error: Gender must be 'MALE' or 'FEMALE'";
    } else if (err.errorNum === 1) {
      errorMessage = "❌ Patient already exists with this ID number";
    }
    
    res.status(500).json({ 
      message: errorMessage, 
      error: err.message,
      errorCode: err.errorNum,
      suggestion: "Patient UID is now set to the same as ID number"
    });
  } finally {
    if (connection) await connection.close();
  }
});

// 16.  Reject user
app.post("/rejectUser", async (req, res) => {
  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);
    
    const userData = req.body;
    const updateSql = `
      UPDATE PENDINGUSERS 
      SET STATUS = 'rejected', 
          REJECTIONREASON = :rejectionReason,
          REJECTEDAT = SYSDATE
      WHERE USER_UID = :userId
    `;

    const bindValues = {
      rejectionReason: userData.REJECTIONREASON || 'No reason provided',
      userId: userData.USER_UID
    };

    const result = await connection.execute(updateSql, bindValues, { autoCommit: true });

    if (result.rowsAffected === 0) {
      return res.status(404).json({ message: "❌ User not found" });
    }

    res.status(200).json({ 
      message: "✅ User rejected successfully"
    });

  } catch (err) {
    console.error("❌ Error rejecting user:", err);
    res.status(500).json({ 
      message: "❌ Error rejecting user", 
      error: err.message 
    });
  } finally {
    if (connection) await connection.close();
  }
});

// 17. Update user data
app.post("/updateUser", async (req, res) => {
  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);
    
    const { USER_UID, ...updatedData } = req.body;
    if (!USER_UID) {
      return res.status(400).json({ message: "❌ USER_UID is required" });
    }

    const setClause = [];
    const bindValues = { userId: USER_UID };

    Object.keys(updatedData).forEach(key => {
      if (updatedData[key] !== undefined && updatedData[key] !== null) {
        if (key === 'BIRTHDATE') {
          const dateObj = new Date(updatedData[key]);
          const formattedDate = dateObj.toISOString().split('T')[0];
          setClause.push(`${key} = TO_DATE(:${key}, 'YYYY-MM-DD')`);
          bindValues[key] = formattedDate;
        } else {
          setClause.push(`${key} = :${key}`);
          bindValues[key] = updatedData[key];
        }
      }
    });

    if (setClause.length === 0) {
      return res.status(400).json({ message: "❌ No data to update" });
    }

    const updateSql = `
      UPDATE PENDINGUSERS 
      SET ${setClause.join(', ')}
      WHERE USER_UID = :userId
    `;
    const result = await connection.execute(updateSql, bindValues, { autoCommit: true });

    if (result.rowsAffected === 0) {
      return res.status(404).json({ message: "❌ User not found" });
    }

    res.status(200).json({ 
      message: "✅ User data updated successfully",
      updatedFields: Object.keys(updatedData)
    });

  } catch (err) {
    console.error("❌ Error updating user:", err);
    res.status(500).json({ 
      message: "❌ Error updating user", 
      error: err.message 
    });
  } finally {
    if (connection) await connection.close();
  }
});

// 18.  Get all rejected users
app.get("/rejectedUsers", async (req, res) => {
  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);
    const result = await connection.execute(
      `SELECT * FROM PENDINGUSERS WHERE STATUS = 'rejected'`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    res.status(200).json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching rejected users:", err);
    res.status(500).json({ message: "❌ Error fetching rejected users", error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

// 19. Get student university ID
app.get("/students/:userId", async (req, res) => {
  const { userId } = req.params;
  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);
    
    const result = await connection.execute(
      `SELECT STUDENT_UNIVERSITY_ID, STUDY_YEAR FROM STUDENTS WHERE USER_ID = :userId`,
      { userId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Student not found" });
    }

    res.json({
      ...result.rows[0],
      studyYear: result.rows[0].STUDY_YEAR ?? null
    });
  } catch (error) {
    console.error("❌ Error fetching student:", error);
    res.status(500).json({ error: "Failed to fetch student data" });
  } finally {
    if (connection) await connection.close();
  }
});



// ✅ Middleware ثاني للتحقق من صلاحيات الأدمن
function isAdmin(req, res, next) {
  if (req.user && req.user.role === "admin") {
    next();
  } else {
    return res.status(403).json({ message: "Access denied, admin only" });
  }
}

// 20. 🔐 Get all users (Admins only) - NEEDS UPDATE
app.get("/users", auth, isAdmin, async (req, res) => {
  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);

    let query = `
      SELECT 
        u.USER_ID,
        u.FIRST_NAME,
        u.FATHER_NAME,
        u.GRANDFATHER_NAME,
        u.FAMILY_NAME,
        u.FULL_NAME,
        u.CREATED_AT,
        u.EMAIL,
        u.IS_ACTIVE,
        u.ROLE,
        u.USERNAME,
        s.STUDENT_UNIVERSITY_ID,
        s.STUDY_YEAR
      FROM USERS u
      LEFT JOIN STUDENTS s ON u.USER_ID = s.USER_ID
    `;
    let binds = {};

    if (req.query.username) {
      query += ` WHERE u.USERNAME = :username`;
      binds = { username: req.query.username };
    }

    const result = await connection.execute(
      query,
      binds,
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const users = result.rows.map(row => {
      const safeRow = {};
      Object.keys(row).forEach(key => {
        safeRow[key] = row[key] || null;
      });
      return safeRow;
    });

    res.status(200).json(users);
  } catch (err) {
    console.error("❌ Error fetching users:", err.message);
    res.status(500).json({ message: "❌ Error fetching users", error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});


// 21. 🔐 Add new user (Admins only) - NEEDS UPDATE
app.post("/users", auth, isAdmin, async (req, res) => {
  let parsedBody;

  if (!req.body) {
    parsedBody = {};
  } else if (typeof req.body === 'string') {
    try {
      parsedBody = JSON.parse(req.body);
    } catch (e) {
      return res.status(400).json({ message: 'Invalid JSON body' });
    }
  } else {
    parsedBody = req.body;
  }

  if (!parsedBody || Object.keys(parsedBody).length === 0) {
    return res.status(400).json({ message: 'Request body is empty or invalid' });
  }
  
  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);

    // ✅ Hash password دائمًا
    let passwordHash;
    if (parsedBody.password) {
      passwordHash = await bcrypt.hash(parsedBody.password, 10);
    } else if (parsedBody.PASSWORD) {
      passwordHash = await bcrypt.hash(parsedBody.PASSWORD, 10);
    } else if (parsedBody.PASSWORD_HASH) {
      passwordHash = parsedBody.PASSWORD_HASH;
    } else {
      passwordHash = await bcrypt.hash('Default123!', 10);
    }

    const userSql = `
      INSERT INTO USERS (
        USER_ID, FIRST_NAME, FATHER_NAME, GRANDFATHER_NAME, FAMILY_NAME,
        FULL_NAME, CREATED_AT, EMAIL, IS_ACTIVE, ROLE, USERNAME, PASSWORD_HASH
      ) VALUES (
        :USER_ID, :FIRST_NAME, :FATHER_NAME, :GRANDFATHER_NAME, :FAMILY_NAME,
        :FULL_NAME, SYSDATE, :EMAIL, :IS_ACTIVE, :ROLE, :USERNAME, :PASSWORD_HASH
      )
    `;

    const userBindValues = {
      USER_ID: parsedBody.USER_ID || parsedBody.STUDENT_ID,
      FIRST_NAME: parsedBody.FIRST_NAME || '',
      FATHER_NAME: parsedBody.FATHER_NAME || '',
      GRANDFATHER_NAME: parsedBody.GRANDFATHER_NAME || '',
      FAMILY_NAME: parsedBody.FAMILY_NAME || '',
      FULL_NAME: parsedBody.FULL_NAME || '',
      EMAIL: parsedBody.EMAIL || '',
      IS_ACTIVE: parsedBody.IS_ACTIVE || 1,
      ROLE: parsedBody.ROLE || 'dental_student',
      USERNAME: parsedBody.USERNAME || '',
      PASSWORD_HASH: passwordHash
    };

    const userResult = await connection.execute(userSql, userBindValues, { autoCommit: false });

    const studentUniversityId =
      parsedBody.STUDENT_UNIVERSITY_ID ||
      parsedBody.STUDENT_ID ||
      parsedBody.studentUniversityId ||
      parsedBody.universityId;
    const studyYearFromBody = extractStudyYear(parsedBody);

    let studentResult = null;
    if (studentUniversityId || studyYearFromBody !== null) {
      const studentColumns = ["USER_ID"];
      const studentValues = [":USER_ID"];
      const studentBindValues = {
        USER_ID: parsedBody.USER_ID || parsedBody.STUDENT_ID,
      };

      if (studentUniversityId) {
        studentColumns.push("STUDENT_UNIVERSITY_ID");
        studentValues.push(":STUDENT_UNIVERSITY_ID");
        studentBindValues.STUDENT_UNIVERSITY_ID = studentUniversityId;
      }

      if (studyYearFromBody !== null) {
        studentColumns.push("STUDY_YEAR");
        studentValues.push(":STUDY_YEAR");
        studentBindValues.STUDY_YEAR = studyYearFromBody;
      }

      const studentSql = `
        INSERT INTO STUDENTS (
          ${studentColumns.join(", ")}
        ) VALUES (
          ${studentValues.join(", ")}
        )
      `;
      studentResult = await connection.execute(studentSql, studentBindValues, { autoCommit: false });
    }

    await connection.commit();
    
    res.status(201).json({ 
      message: "✅ User added successfully", 
      rowsAffected: userResult.rowsAffected,
      studentAdded: !!studentResult
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
    res.status(500).json({ 
      message: "❌ Error adding user", 
      error: err.message
    });
  } finally {
    if (connection) await connection.close();
  }
});


// 22. User CRUD operations - NEEDS UPDATE
app.route("/users/:id")
  .get(async (req, res) => {
    const { id } = req.params;
    let connection;
    try {
      connection = await oracledb.getConnection(dbConfig);

      const result = await connection.execute(
        `SELECT 
          u.USER_ID,
          u.FIRST_NAME,
          u.FATHER_NAME,
          u.GRANDFATHER_NAME,
          u.FAMILY_NAME,
          u.FULL_NAME,
          u.CREATED_AT,
          u.EMAIL,
          u.IS_ACTIVE,
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

      res.status(200).json(result.rows[0]);
    } catch (err) {
      console.error("❌ Error fetching user:", err.message);
      res.status(500).json({ message: "❌ Error fetching user", error: err.message });
    } finally {
      if (connection) await connection.close();
    }
  })
  .put(async (req, res) => {
    const { id } = req.params;
    let connection;
    let parsedBody;
    
    if (!req.body) {
      parsedBody = {};
    } else if (typeof req.body === 'string') {
      try {
        parsedBody = JSON.parse(req.body);
      } catch (e) {
        return res.status(400).json({ message: 'Invalid JSON body' });
      }
    } else {
      parsedBody = req.body;
    }
    
    try {
      connection = await oracledb.getConnection(dbConfig);

      const updates = [];
      const bindValues = { id };
      
      if (parsedBody.IS_ACTIVE !== undefined && parsedBody.IS_ACTIVE !== null) {
        updates.push('IS_ACTIVE = :is_active');
        bindValues.is_active = parsedBody.IS_ACTIVE;
      }
      
      // الحقول المتاحة في الجدول الجديد
      const fields = ['FIRST_NAME', 'FATHER_NAME', 'GRANDFATHER_NAME', 'FAMILY_NAME', 
                     'FULL_NAME', 'USERNAME', 'EMAIL', 'ROLE'];
      
      fields.forEach(field => {
        if (parsedBody[field] !== undefined && parsedBody[field] !== null && parsedBody[field] !== '') {
          updates.push(`${field} = :${field.toLowerCase()}`);
          bindValues[field.toLowerCase()] = parsedBody[field];
        }
      });

      if (updates.length === 0) {
        return res.status(400).json({ message: "No valid fields to update" });
      }

      const setClause = updates.join(', ');
      const sql = `UPDATE USERS SET ${setClause} WHERE USER_ID = :id`;

      const result = await connection.execute(
        sql,
        bindValues,
        { autoCommit: true }
      );

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
            updateColumns.push("STUDENT_UNIVERSITY_ID = :studentUniversityId");
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
                autoCommit: true,
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
              autoCommit: true,
            });
            studentUpdateResult = true;
          }
        } catch (studentErr) {
          console.error("❌ Error updating STUDENTS table:", studentErr.message);
        }
      }

      if (result.rowsAffected === 0) {
        return res.status(404).json({ message: "User not found" });
      }

      res.status(200).json({ 
        message: "✅ User updated successfully", 
        rowsAffected: result.rowsAffected,
        updatedFields: updates,
        studentUpdated: !!studentUpdateResult
      });
      
    } catch (err) {
      console.error("❌ Error updating user:", err);
      res.status(500).json({ 
        message: "❌ Error updating user", 
        error: err.message
      });
    } finally {
      if (connection) await connection.close();
    }
  })
  .delete(async (req, res) => {
    const { id } = req.params;
    let connection;
    try {
      connection = await oracledb.getConnection(dbConfig);
      const result = await connection.execute(
        `DELETE FROM USERS WHERE USER_ID = :id`,
        { id },
        { autoCommit: true }
      );
      
      if (result.rowsAffected === 0) {
        return res.status(404).json({ message: "User not found" });
      }
      
      res.status(200).json({ 
        message: "✅ User deleted successfully", 
        rowsAffected: result.rowsAffected 
      });
    } catch (err) {
      console.error("❌ Error deleting user:", err);
      res.status(500).json({ 
        message: "❌ Error deleting user", 
        error: err.message 
      });
    } finally {
      if (connection) await connection.close();
    }
  });


// 23. Login endpoint - NEEDS UPDATE
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
    connection = await oracledb.getConnection(dbConfig);

    const result = await connection.execute(
      `SELECT * FROM USERS WHERE LOWER(email) = :email OR LOWER(username) = :email`,
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
    for (const key of Object.keys(userRaw)) {
      if (key !== "PASSWORD_HASH") {
        safeUser[key] = userRaw[key];
      }
    }

    // ✅ إنشاء توكن JWT
    const token = jwt.sign(
      {
        id: safeUser.USER_ID,
        email: safeUser.EMAIL,
        role: safeUser.ROLE,
      },
      process.env.JWT_SECRET,
      { expiresIn: "2h" }
    );

    // ✅ إرسال الرد النهائي
    return res.status(200).json({
      message: "Login successful",
      token,
      user: safeUser,
    });
  } catch (err) {
    console.error("❌ Login Error:", err);
    res.status(500).json({
      message: "❌ Error processing login",
      error: err.message,
    });
  } finally {
    if (connection) await connection.close();
  }
});




// 24.Image upload endpoint
app.post('/upload-image', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'لم يتم رفع أي صورة' });
  }
  try {
    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: 'user_images'
    });

    const fs = require('fs');
    fs.unlink(req.file.path, () => {});
    res.json({ imageUrl: result.secure_url });
  } catch (err) {
    res.status(500).json({ message: 'خطأ في رفع الصورة إلى Cloudinary', error: err.message });
  }
});

// 25. Get all doctors - FIXED (استخدام الكود القديم مع auth)
app.get("/doctors", auth, async (req, res) => {
  let connection;
  try {
    connection = await getConnection();

    const result = await connection.execute(
      `SELECT u.*, 
              DBMS_LOB.SUBSTR(d.ALLOWED_FEATURES, 4000, 1) as ALLOWED_FEATURES,
              d.DOCTOR_TYPE,
              d.IS_ACTIVE
       FROM DOCTORS d JOIN USERS u ON u.USER_ID = TO_CHAR(d.DOCTOR_ID)`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    
    const doctors = result.rows.map(row => {
      const safeRow = {};

      Object.keys(row).forEach(key => {
        if (key === 'IMAGE' || key === 'ID_IMAGE') {
          safeRow[key] = typeof row[key] === 'string' ? row[key] : '';
        } else if (key === 'ALLOWED_FEATURES') {
          try {
            let featuresValue = row[key];            
            if (featuresValue && typeof featuresValue === 'string' && featuresValue.trim() !== '') {
              safeRow[key] = JSON.parse(featuresValue);
            } else {
              safeRow[key] = [];
            }
          } catch (e) {
            console.error(`❌ خطأ في تحويل ALLOWED_FEATURES للطبيب ${row.FULL_NAME}:`, e);
            safeRow[key] = [];
          }
        } else {
          safeRow[key] = row[key];
        }
      });
      
      const nameFromDb = row.FULL_NAME || row.NAME || row.FIRST_NAME || row.USERNAME || '';
      safeRow['name'] = nameFromDb;
      safeRow['fullName'] = row.FULL_NAME || nameFromDb;
      safeRow['uid'] = row.USER_ID;
      safeRow['id'] = row.USER_ID;
      safeRow['allowedFeatures'] = Array.isArray(safeRow['ALLOWED_FEATURES']) ? safeRow['ALLOWED_FEATURES'] : [];
      
      let doctorType = 'طبيب عام';
      
      if (row.DOCTOR_TYPE !== null && row.DOCTOR_TYPE !== undefined && row.DOCTOR_TYPE !== '') {
        doctorType = row.DOCTOR_TYPE;
      } else {
        doctorType = row.ROLE || 'طبيب عام';
      }
      
      safeRow['type'] = doctorType;
      safeRow['DOCTOR_TYPE'] = doctorType;
          
      return safeRow;
    });
    
    res.status(200).json(doctors);
  } catch (err) {
    console.error('❌ Error fetching doctors:', err);
    res.status(500).json({ message: '❌ Error fetching doctors', error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

// 26. Get single doctor with features - FIXED (استخدام الكود القديم مع auth)
app.get("/doctors/:id", auth, async (req, res) => {
  const { id } = req.params;
  let connection;
  try {
    connection = await getConnection();
    
    const sql = `
      SELECT 
        u.USER_ID,
        u.FULL_NAME,
        u.FIRST_NAME,
        u.FATHER_NAME,
        u.GRANDFATHER_NAME,
        u.FAMILY_NAME,
        u.GENDER,
        u.BIRTH_DATE,
        u.EMAIL,
        u.PHONE,
        u.ADDRESS,
        u.ID_NUMBER,
        u.IS_ACTIVE,
        u.ROLE,
        u.USERNAME,
        u.IMAGE,
        d.DOCTOR_ID,
        d.DOCTOR_TYPE,
        d.IS_ACTIVE as DOCTOR_IS_ACTIVE,
        DBMS_LOB.SUBSTR(d.ALLOWED_FEATURES, 4000, 1) as ALLOWED_FEATURES
      FROM DOCTORS d 
      JOIN USERS u ON u.USER_ID = TO_CHAR(d.DOCTOR_ID)
      WHERE u.USER_ID = :id OR TO_CHAR(d.DOCTOR_ID) = :id
    `;

    const result = await connection.execute(
      sql,
      { id },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    
    if (!result.rows || result.rows.length === 0) {
      return res.status(404).json({ 
        message: "Doctor not found",
        attemptedId: id,
        suggestion: "تأكد أن المستخدم موجود في جدول DOCTORS وله علاقة مع USERS"
      });
    }
    
    const doctor = result.rows[0];
    let allowedFeatures = [];
    
    try {
      const featuresValue = doctor.ALLOWED_FEATURES;      
      if (featuresValue && typeof featuresValue === 'string' && featuresValue.trim() !== '') {
        const parsed = JSON.parse(featuresValue);
        allowedFeatures = Array.isArray(parsed) ? parsed : [];
      } else {
        allowedFeatures = [];
      }
    } catch (e) {
      console.error('❌ خطأ في تحويل ALLOWED_FEATURES:', e);
      allowedFeatures = [];
    }

    const response = {
      USER_ID: doctor.USER_ID,
      FULL_NAME: doctor.FULL_NAME,
      FIRST_NAME: doctor.FIRST_NAME,
      FATHER_NAME: doctor.FATHER_NAME,
      GRANDFATHER_NAME: doctor.GRANDFATHER_NAME,
      FAMILY_NAME: doctor.FAMILY_NAME,
      GENDER: doctor.GENDER,
      BIRTH_DATE: doctor.BIRTH_DATE,
      EMAIL: doctor.EMAIL,
      PHONE: doctor.PHONE,
      ADDRESS: doctor.ADDRESS,
      ID_NUMBER: doctor.ID_NUMBER,
      IS_ACTIVE: doctor.IS_ACTIVE,
      ROLE: doctor.ROLE,
      USERNAME: doctor.USERNAME,
      IMAGE: doctor.IMAGE,
      
      DOCTOR_ID: doctor.DOCTOR_ID,
      DOCTOR_TYPE: doctor.DOCTOR_TYPE || 'طبيب عام',
      DOCTOR_IS_ACTIVE: doctor.DOCTOR_IS_ACTIVE,
      
      ALLOWED_FEATURES: allowedFeatures,
      allowedFeatures: allowedFeatures
    };    
    
    res.status(200).json(response);
  } catch (err) {
    console.error('❌ Error fetching doctor:', err);
    res.status(500).json({ 
      message: '❌ Error fetching doctor', 
      error: err.message,
      attemptedId: id
    });
  } finally {
    if (connection) await connection.close();
  }
});

// 27. Get doctor type only - FIXED (استخدام الكود القديم مع auth)
app.get("/doctors/:id/type", auth, async (req, res) => {
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

    const doctorType = result.rows[0].DOCTOR_TYPE || 'طبيب عام';
    
    res.status(200).json({ 
      doctorType: doctorType,
      type: doctorType 
    });
  } catch (err) {
    console.error('❌ Error fetching doctor type:', err);
    res.status(500).json({ message: '❌ Error fetching doctor type', error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

// 28. Update doctor type - FIXED (استخدام الكود القديم مع auth)
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

    res.status(200).json({ message: "✅ Doctor type updated successfully" });
  } catch (err) {
    console.error('❌ Error updating doctor type:', err);
    res.status(500).json({ message: '❌ Error updating doctor type', error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});


// 29. Update doctor features - FIXED (استخدام الكود القديم مع auth)
app.put("/doctors/:id/features", auth, async (req, res) => {
  const { id } = req.params;
  const { allowedFeatures } = req.body;

  if (!Array.isArray(allowedFeatures)) {
    return res.status(400).json({ message: "allowedFeatures must be an array" });
  }

  let connection;
  try {
    connection = await getConnection();

    const featuresJson = JSON.stringify(allowedFeatures);

    const sql = `UPDATE DOCTORS SET ALLOWED_FEATURES = :features WHERE DOCTOR_ID = TO_NUMBER(:id)`;
    const result = await connection.execute(
      sql,
      { features: featuresJson, id },
      { autoCommit: true }
    );

    if (result.rowsAffected === 0) {
      return res.status(404).json({ message: "Doctor not found" });
    }

    res.status(200).json({ 
      message: "✅ Doctor features updated successfully",
      updatedFeatures: allowedFeatures 
    });
  } catch (err) {
    console.error('❌ Error updating doctor features:', err);
    res.status(500).json({ message: '❌ Error updating doctor features', error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

// 30. Update multiple doctors features - FIXED (استخدام الكود القديم مع auth)
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
    const results = [];

    const updatePromises = doctorIds.map(async (doctorId) => {
      try {
        
        const sql = `UPDATE DOCTORS SET ALLOWED_FEATURES = :features WHERE DOCTOR_ID = :id`;
        
        const result = await connection.execute(
          sql,
          { 
            features: featuresJson, 
            id: doctorId 
          },
          { autoCommit: false }
        );
        
        if (result.rowsAffected > 0) {
          successCount++;
          return { id: doctorId, status: 'success' };
        } else {
          return { id: doctorId, status: 'not_found' };
        }
      } catch (error) {
        console.error(`❌ خطأ في الطبيب ${doctorId}:`, error.message);
        return { id: doctorId, status: 'error', error: error.message };
      }
    });

    const updateResults = await Promise.all(updatePromises);
    
    await connection.commit();
    
    const failedCount = updateResults.filter(r => r.status !== 'success').length;
    
    res.status(200).json({ 
      message: `✅ تم تحديث ${successCount} طبيب, ${failedCount} فشل`,
      successCount,
      failedCount,
      details: updateResults
    });
    
  } catch (err) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackErr) {
        console.error("❌ Rollback error:", rollbackErr);
      }
    }
    console.error('❌ Error in batch update:', err);
    res.status(500).json({ 
      message: '❌ Error updating doctor features', 
      error: err.message 
    });
  } finally {
    if (connection) await connection.close();
  }
});

// 31. Simple batch update - FIXED (استخدام الكود القديم مع auth)
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
      
      if (result.rowsAffected > 0) {
        successCount++;
      } else {
        failCount++;
      }
    } catch (error) {
      failCount++;
      console.error(`❌ خطأ في الطبيب ${doctorId}:`, error.message);
    } finally {
      if (connection) await connection.close();
    }
  }

  res.status(200).json({ 
    message: `✅ تم تحديث ${successCount} طبيب, ${failCount} فشل`,
    successCount,
    failCount
  });
});

// 🔥 Doctor info endpoint - FIXED VERSION
app.get("/doctor-info/:id", auth, async (req, res) => {
  const { id } = req.params;
  let connection;
  
  try {
    connection = await getConnection();

    // 🔥 جلب بيانات المستخدم أولاً (من جدول USERS)
    const userSql = `
      SELECT 
        USER_ID,
        FULL_NAME,
        FIRST_NAME,
        FATHER_NAME, 
        GRANDFATHER_NAME,
        FAMILY_NAME,
        EMAIL,
        PHONE,
        IS_ACTIVE,
        ROLE,
        USERNAME,
        IMAGE
      FROM USERS 
      WHERE USER_ID = :id AND ROLE = 'doctor'
    `;
    
    const userResult = await connection.execute(
      userSql,
      { id },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (!userResult.rows || userResult.rows.length === 0) {
      return res.status(404).json({ 
        message: "Doctor not found in USERS table",
        attemptedId: id 
      });
    }

    const userData = userResult.rows[0];
    
    // 🔥 جلب بيانات الطبيب من جدول DOCTORS إذا موجود
    let doctorData = {};
    try {
      const doctorSql = `
        SELECT 
          DOCTOR_TYPE,
          IS_ACTIVE as DOCTOR_IS_ACTIVE,
          DBMS_LOB.SUBSTR(ALLOWED_FEATURES, 4000, 1) as ALLOWED_FEATURES
        FROM DOCTORS 
        WHERE USER_ID = :id OR TO_CHAR(DOCTOR_ID) = :id
      `;
      
      const doctorResult = await connection.execute(
        doctorSql,
        { id },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      
      if (doctorResult.rows && doctorResult.rows.length > 0) {
        doctorData = doctorResult.rows[0];
      }
    } catch (doctorErr) {
      console.log("⚠️ No doctor-specific data found, using user data only");
    }

    // 🔥 معالجة ALLOWED_FEATURES
    let allowedFeatures = [];
    try {
      const featuresValue = doctorData.ALLOWED_FEATURES;
      if (featuresValue && typeof featuresValue === 'string' && featuresValue.trim() !== '') {
        const parsed = JSON.parse(featuresValue);
        allowedFeatures = Array.isArray(parsed) ? parsed : [];
      }
    } catch (e) {
      console.error('❌ Error parsing ALLOWED_FEATURES:', e);
      allowedFeatures = [];
    }

    // 🔥 بناء الرد
    const response = {
      USER_ID: userData.USER_ID,
      FULL_NAME: userData.FULL_NAME,
      FIRST_NAME: userData.FIRST_NAME,
      FATHER_NAME: userData.FATHER_NAME,
      GRANDFATHER_NAME: userData.GRANDFATHER_NAME,
      FAMILY_NAME: userData.FAMILY_NAME,
      EMAIL: userData.EMAIL,
      PHONE: userData.PHONE,
      IS_ACTIVE: userData.IS_ACTIVE,
      ROLE: userData.ROLE,
      USERNAME: userData.USERNAME,
      IMAGE: userData.IMAGE,

      // بيانات الطبيب
      DOCTOR_TYPE: doctorData.DOCTOR_TYPE || 'طبيب عام',
      DOCTOR_IS_ACTIVE: doctorData.DOCTOR_IS_ACTIVE !== undefined ? doctorData.DOCTOR_IS_ACTIVE : 1,
      
      ALLOWED_FEATURES: allowedFeatures,
      allowedFeatures: allowedFeatures
    };

    console.log(`✅ Doctor info fetched successfully for: ${userData.FULL_NAME}`);
    return res.status(200).json(response);

  } catch (err) {
    console.error('❌ Error fetching doctor info:', err);
    return res.status(500).json({
      message: '❌ Error fetching doctor info',
      error: err.message,
      attemptedId: id
    });
  } finally {
    if (connection) await connection.close();
  }
});

// 32. Check if ID exists in pending users
app.post("/pendingUsers/check-id", async (req, res) => {
  const { idNumber } = req.body;
  if (!idNumber) {
    return res.status(400).json({ message: "ID number is required" });
  }

  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);
    const result = await connection.execute(
      `SELECT COUNT(*) AS COUNT FROM PENDINGUSERS WHERE IDNUMBER = :idNumber`,
      { idNumber },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (result.rows[0].COUNT > 0) {
      return res.status(409).json({ message: "ID number already exists in pending users" });
    }

    res.status(200).json({ message: "ID number is available" });
  } catch (err) {
    console.error("❌ Error checking ID in pending users:", err);
    res.status(500).json({ message: "❌ Error checking ID in pending users", error: err.message });
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
    connection = await oracledb.getConnection(dbConfig);

    const dateOnly = appointment_date.split('T')[0];

    const sql = `
      INSERT INTO APPOINTMENTS (
        ID,
        APPOINTMENT_DATE,
        START_TIME,
        END_TIME,
        STUDENT_ID,
        PATIENT_NAME,
        PATIENT_ID_NUMBER,
        STUDENT_UNIVERSITY_ID,
        CREATED_AT,
        STATUS
      ) VALUES (
        :id,
        TO_DATE(:appointment_date, 'YYYY-MM-DD'),
        :start_time,
        :end_time,
        :student_id,
        :patient_name,
        :patient_id_number,
        :student_university_id,
        SYSTIMESTAMP,
        :status
      )
    `;

    const bindValues = {
      id: Date.now(),
      appointment_date: dateOnly,
      start_time: start_time || 'إقرار',
      end_time: end_time || '',
      student_id,
      patient_name: patient_name || '',
      patient_id_number: patient_id_number || '',
      student_university_id: student_university_id || '2021XXXX',
      status: status || 'pending'
    };

    const result = await connection.execute(sql, bindValues, { autoCommit: true });
    res.status(201).json({ message: "✅ تم حجز الموعد بنجاح", rowsAffected: result.rowsAffected });
  } catch (err) {
    console.error("❌ Error creating appointment:", err.message);
    res.status(500).json({ message: "❌ فشل حجز الموعد", error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

// 34. Get appointment count
app.get('/appointments/count', async (req, res) => {
  const { date } = req.query;
  
  if (!date) {
    return res.status(400).json({ error: "Missing date parameter" });
  }

  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);
    
    const result = await connection.execute(
      `SELECT COUNT(*) AS COUNT FROM APPOINTMENTS 
       WHERE TO_CHAR(APPOINTMENT_DATE, 'YYYY-MM-DD') = :input_date`,
      { input_date: date.split('T')[0] },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    res.json({ count: result.rows[0].COUNT || 0 });
    
  } catch (error) {
    console.error("❌ Error fetching appointment count:", error);
    res.status(500).json({ error: "Failed to fetch appointment count." });
  } finally {
    if (connection) await connection.close();
  }
});

// 35. Get booking settings
app.get('/bookingSettings', async (req, res) => {
  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);

    const result = await connection.execute(
      `SELECT FOURTH_YEAR_LIMIT, FIFTH_YEAR_LIMIT FROM BOOKING_SETTINGS`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: "No booking settings found." });
      return;
    }

    const settings = result.rows[0];
    res.json({
      fourthYearLimit: settings.FOURTH_YEAR_LIMIT,
      fifthYearLimit: settings.FIFTH_YEAR_LIMIT
    });
  } catch (error) {
    console.error("❌ Error fetching booking settings:", error);
    res.status(500).json({ error: "Failed to fetch booking settings." });
  } finally {
    if (connection) await connection.close();
  }
});

// 36. Get all waiting list entries - FIXED CIRCULAR REFERENCE
app.get("/waitingList", async (req, res) => {
  let connection;
  try {
    console.log("🔍 Connecting to database for waiting list...");
    connection = await oracledb.getConnection(dbConfig);
    console.log("✅ Database connected for waiting list");

    const result = await connection.execute(
      `SELECT 
        w.WAITING_ID,
        w.PATIENT_UID,
        w.PATIENT_NAME,
        TO_CHAR(w.APPOINTMENT_DATE, 'YYYY-MM-DD') as APPOINTMENT_DATE,
        w.PHONE,
        w.STATUS,
        w.NOTES,
        TO_CHAR(w.CREATED_AT, 'YYYY-MM-DD HH24:MI:SS') as CREATED_AT,
        p.FIRSTNAME,
        p.FAMILYNAME,
        p.MEDICAL_RECORD_NO
       FROM WAITING_LIST w
       LEFT JOIN PATIENTS p ON w.PATIENT_UID = p.PATIENT_UID
       ORDER BY w.CREATED_AT DESC`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    console.log(`✅ Query executed successfully, found ${result.rows ? result.rows.length : 0} rows`);

    // 🔥 FIX: تحويل البيانات بشكل آمن بدون circular reference
    const safeData = result.rows.map(row => {
      const safeRow = {};
      Object.keys(row).forEach(key => {
        // تجاهل أي خصائص معقدة من Oracle
        if (row[key] === null || row[key] === undefined) {
          safeRow[key] = row[key];
        } else if (typeof row[key] === 'string' || 
                   typeof row[key] === 'number' || 
                   typeof row[key] === 'boolean') {
          safeRow[key] = row[key];
        } else {
          // لأي كائن آخر، حوله إلى سلسلة نصية
          try {
            safeRow[key] = String(row[key]);
          } catch {
            safeRow[key] = null;
          }
        }
      });
      return safeRow;
    });

    console.log("✅ Sending safe response...");
    res.status(200).json(safeData);
    
  } catch (err) {
    console.error("❌ Error fetching waiting list:", err);
    res.status(500).json({ 
      message: "❌ Error fetching waiting list", 
      error: err.message 
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
        console.log("✅ Database connection closed for waiting list");
      } catch (closeErr) {
        console.error("❌ Error closing connection:", closeErr);
      }
    }
  }
});





// 37. Add to waiting list - FIXED PATIENT_UID = IDNUMBER
app.post("/waitingList", async (req, res) => {
  const { PATIENT_UID, PATIENT_NAME, APPOINTMENT_DATE, STATUS, PHONE, NOTES } = req.body;

  if (!PATIENT_UID || !PATIENT_NAME || !APPOINTMENT_DATE) {
    return res.status(400).json({ 
      message: "❌ Missing required fields",
      required: ['PATIENT_UID', 'PATIENT_NAME', 'APPOINTMENT_DATE'],
      received: { PATIENT_UID, PATIENT_NAME, APPOINTMENT_DATE, STATUS, PHONE, NOTES }
    });
  }

  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);

    // 🔥 FIX: Search for patient using IDNUMBER as PATIENT_UID
    const checkPatientSql = `SELECT COUNT(*) as COUNT FROM PATIENTS WHERE PATIENT_UID = :patient_uid`;
    const patientCheckResult = await connection.execute(
      checkPatientSql,
      { patient_uid: PATIENT_UID },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (patientCheckResult.rows[0].COUNT === 0) {
      return res.status(404).json({ 
        message: "❌ المريض غير مسجل في النظام. يجب الموافقة على المريض أولاً.",
        patientUid: PATIENT_UID,
        suggestion: "تأكد من أن المريض قد تمت الموافقة عليه وتم نقله إلى جدول PATIENTS"
      });
    }

    // 🔥 SECOND: Check for duplicates in waiting list
    const checkDuplicateSql = `
      SELECT COUNT(*) as COUNT 
      FROM WAITING_LIST 
      WHERE PATIENT_UID = :patient_uid 
      AND APPOINTMENT_DATE = TO_DATE(:appointment_date, 'YYYY-MM-DD')
    `;
    
    const duplicateCheckResult = await connection.execute(
      checkDuplicateSql,
      {
        patient_uid: PATIENT_UID,
        appointment_date: APPOINTMENT_DATE.split('T')[0]
      },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (duplicateCheckResult.rows[0].COUNT > 0) {
      return res.status(409).json({ 
        message: "❌ المريض موجود مسبقاً في قائمة الانتظار لهذا اليوم" 
      });
    }

    // 🔥 THIRD: Insert into waiting list
    const insertSql = `
      INSERT INTO WAITING_LIST (
        WAITING_ID,
        PATIENT_UID,
        PATIENT_NAME,
        APPOINTMENT_DATE,
        STATUS,
        PHONE,
        NOTES,
        CREATED_AT
      ) VALUES (
        :waiting_id,
        :patient_uid,
        :patient_name,
        TO_DATE(:appointment_date, 'YYYY-MM-DD'),
        :status,
        :phone,
        :notes,
        SYSTIMESTAMP
      )
    `;

    const bindValues = {
      waiting_id: `WL_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      patient_uid: PATIENT_UID, // 🔥 استخدام نفس الـ IDNUMBER كـ PATIENT_UID
      patient_name: PATIENT_NAME,
      appointment_date: APPOINTMENT_DATE.split('T')[0],
      status: STATUS || 'WAITING',
      phone: PHONE || '',
      notes: NOTES || ''
    };


    const result = await connection.execute(insertSql, bindValues, { autoCommit: true });
    

    res.status(201).json({ 
      message: "✅ تمت الإضافة إلى قائمة الانتظار بنجاح", 
      rowsAffected: result.rowsAffected,
      waitingId: bindValues.waiting_id
    });
  } catch (err) {
    console.error("❌ Error adding to waiting list:", err);
    
    let errorMessage = "❌ فشل الإضافة إلى قائمة الانتظار";
    if (err.errorNum === 2291) {
      errorMessage = "❌ المريض غير مسجل في النظام. يجب الموافقة على المريض أولاً قبل إضافته إلى قائمة الانتظار.";
    }
    
    res.status(500).json({ 
      message: errorMessage, 
      error: err.message,
      errorCode: err.errorNum,
      details: {
        PATIENT_UID,
        PATIENT_NAME, 
        APPOINTMENT_DATE
      }
    });
  } finally {
    if (connection) await connection.close();
  }
});

// 38. Remove from waiting list
app.delete("/waitingList/:id", async (req, res) => {
  const { id } = req.params;
  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);

    const result = await connection.execute(
      `DELETE FROM WAITING_LIST WHERE WAITING_ID = :id`,
      { id },
      { autoCommit: true }
    );

    if (result.rowsAffected === 0) {
      return res.status(404).json({ message: "❌ Entry not found in waiting list" });
    }

    res.status(200).json({ message: "✅ تمت الإزالة من قائمة الانتظار بنجاح" });
  } catch (err) {
    console.error("❌ Error removing from waiting list:", err);
    res.status(500).json({ message: "❌ فشل الإزالة من قائمة الانتظار", error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});


// 39. Get all patient exams - FIXED ORA-01745
app.get("/patientExams", async (req, res) => {
  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);

    let query = `
      SELECT e.*, p.FIRSTNAME, p.FAMILYNAME, p.MEDICAL_RECORD_NO
      FROM PATIENT_EXAMS e
      JOIN PATIENTS p ON e.PATIENT_UID = p.PATIENT_UID
    `;
    let binds = {};

    // 🔥 FIX: Use proper bind variable names
    if (req.query.patientName && req.query.date) {
      query += ` WHERE e.PATIENT_NAME = :patient_name AND e.APPOINTMENT_DATE = TO_DATE(:exam_date, 'YYYY-MM-DD')`;
      binds = { 
        patient_name: req.query.patientName,
        exam_date: req.query.date.split('T')[0]
      };
    }

    query += ` ORDER BY e.EXAMINED_AT DESC`;

    const result = await connection.execute(query, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });

    res.status(200).json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching patient exams:", err);
    res.status(500).json({ message: "❌ Error fetching patient exams", error: err.message });
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
    connection = await oracledb.getConnection(dbConfig);

    const sql = `
      INSERT INTO PATIENT_EXAMS (
        EXAM_ID,
        PATIENT_UID,
        PATIENT_NAME,
        APPOINTMENT_DATE,
        EXAMINED_BY,
        EXAM_RESULTS,
        DIAGNOSIS,
        TREATMENT_PLAN,
        PRESCRIPTION,
        STATUS,
        EXAMINED_AT
      ) VALUES (
        :exam_id,
        :patient_uid,
        :patient_name,
        TO_DATE(:appointment_date, 'YYYY-MM-DD'),
        :examined_by,
        :exam_results,
        :diagnosis,
        :treatment_plan,
        :prescription,
        :status,
        SYSTIMESTAMP
      )
    `;

    const bindValues = {
      exam_id: `EXAM_${Date.now()}`,
      patient_uid: PATIENT_UID,
      patient_name: PATIENT_NAME,
      appointment_date: APPOINTMENT_DATE.split('T')[0],
      examined_by: EXAMINED_BY || '',
      exam_results: EXAM_RESULTS || '',
      diagnosis: DIAGNOSIS || '',
      treatment_plan: TREATMENT_PLAN || '',
      prescription: PRESCRIPTION || '',
      status: STATUS || 'COMPLETED'
    };

    const result = await connection.execute(sql, bindValues, { autoCommit: true });
    res.status(201).json({ message: "✅ تم تسجيل الفحص بنجاح", rowsAffected: result.rowsAffected });
  } catch (err) {
    console.error("❌ Error creating patient exam:", err);
    res.status(500).json({ message: "❌ فشل تسجيل الفحص", error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

// 41. Get all appointments
app.get("/appointments", async (req, res) => {
  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);

    let query = `
      SELECT a.*, s.STUDENT_UNIVERSITY_ID, u.FULL_NAME as STUDENT_NAME
      FROM APPOINTMENTS a
      LEFT JOIN STUDENTS s ON a.STUDENT_ID = s.USER_ID
      LEFT JOIN USERS u ON a.STUDENT_ID = u.USER_ID
    `;
    let binds = {};

    if (req.query.date) {
      query += ` WHERE TRUNC(a.APPOINTMENT_DATE) = TO_DATE(:date, 'YYYY-MM-DD')`;
      binds = { date: req.query.date.split('T')[0] };
    }

    query += ` ORDER BY a.APPOINTMENT_DATE, a.START_TIME`;

    const result = await connection.execute(query, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });

    res.status(200).json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching appointments:", err);
    res.status(500).json({ message: "❌ Error fetching appointments", error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

// 42. Get patient by ID - المحسنة
app.get("/patients/:id", async (req, res) => {
  const { id } = req.params;
  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);

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
        CREATEDAT
       FROM PATIENTS 
       WHERE PATIENT_UID = :id`,
      { id },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (!result.rows || result.rows.length === 0) {
      return res.status(404).json({ 
        message: "❌ Patient not found in PATIENTS table",
        patientId: id 
      });
    }

    const patient = result.rows[0];

    res.status(200).json(patient);
  } catch (err) {
    console.error("❌ Error fetching patient:", err);
    res.status(500).json({ 
      message: "❌ Error fetching patient", 
      error: err.message,
      patientId: id 
    });
  } finally {
    if (connection) await connection.close();
  }
});

//  43. Update booking settings
app.put("/bookingSettings", async (req, res) => {
  const { fourthYearLimit, fifthYearLimit } = req.body;

  if (fourthYearLimit === undefined || fifthYearLimit === undefined) {
    return res.status(400).json({ message: "❌ Both limits are required" });
  }

  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);

    const result = await connection.execute(
      `UPDATE BOOKING_SETTINGS SET FOURTH_YEAR_LIMIT = :fourth, FIFTH_YEAR_LIMIT = :fifth`,
      { fourth: fourthYearLimit, fifth: fifthYearLimit },
      { autoCommit: true }
    );

    res.status(200).json({ message: "✅ تم تحديث إعدادات الحجز بنجاح" });
  } catch (err) {
    console.error("❌ Error updating booking settings:", err);
    res.status(500).json({ message: "❌ فشل تحديث إعدادات الحجز", error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});


// 44.NEW ENDPOINT: Add doctor to DOCTORS table
app.post("/doctors", async (req, res) => {
  let { DOCTOR_ID, ALLOWED_FEATURES, DOCTOR_TYPE, IS_ACTIVE } = req.body;

  // 🔹 تحويل صريح للأرقام
  DOCTOR_ID = parseInt(DOCTOR_ID, 10);
  IS_ACTIVE = IS_ACTIVE !== undefined ? parseInt(IS_ACTIVE, 10) : 1;

  if (isNaN(DOCTOR_ID)) {
    return res.status(400).json({ message: "❌ DOCTOR_ID must be numeric" });
  }

  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);

    const bindValues = {
      doctor_id: DOCTOR_ID,
      allowed_features: JSON.stringify(ALLOWED_FEATURES || []),
      doctor_type: DOCTOR_TYPE || 'طبيب عام',
      is_active: IS_ACTIVE
    };

    console.log("🔍 Bind Values =>", bindValues);
    console.log("typeof doctor_id:", typeof bindValues.doctor_id);
    console.log("typeof is_active:", typeof bindValues.is_active);

    await connection.execute(
      `INSERT INTO DOCTORS (DOCTOR_ID, ALLOWED_FEATURES, DOCTOR_TYPE, IS_ACTIVE, CREATED_AT, UPDATED_AT)
       VALUES (:doctor_id, :allowed_features, :doctor_type, :is_active, SYSTIMESTAMP, SYSTIMESTAMP)`,
      bindValues,
      { autoCommit: true }
    );

    res.status(201).json({ message: "✅ Doctor added successfully", doctorId: DOCTOR_ID });
  } catch (err) {
    console.error("❌ Error adding doctor:", err);
    res.status(500).json({ message: "❌ Database Error", error: err.message, errorCode: err.errorNum });
  } finally {
    if (connection) await connection.close();
  }
});



// 45. Get all examinations with basic data - FINAL FIXED VERSION
app.get("/all-examinations-simple", async (req, res) => {
  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);

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
        u.FULL_NAME as DOCTOR_NAME
      FROM EXAMINATIONS e
      LEFT JOIN PATIENTS p ON e.PATIENT_UID = p.PATIENT_UID
      LEFT JOIN USERS u ON e.DOCTOR_ID = u.USER_ID
      ORDER BY e.EXAM_DATE DESC
    `;

    const result = await connection.execute(
      sql,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (!result.rows || result.rows.length === 0) {
      return res.status(200).json([]);
    }

    const examinations = [];

    for (let i = 0; i < result.rows.length; i++) {
      const row = result.rows[i];
      
      try {
        const exam = {
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

        examinations.push(exam);
      } catch (rowError) {
        console.error(`❌ خطأ في معالجة الصف ${i}:`, rowError);
        // تخطي هذا الصف والمتابعة
        continue;
      }
    }    
    // إرجاع البيانات بشكل آمن
    res.status(200).json(examinations);

  } catch (err) {
    console.error("❌ Error fetching all examinations:", err);
    res.status(500).json({ 
      message: "❌ Error fetching examinations", 
      error: err.message 
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (closeErr) {
        console.error("❌ Error closing connection:", closeErr);
      }
    }
  }
});

//46. Get full examination details by exam ID
app.get("/examination-details/:examId", async (req, res) => {
  let connection;
  try {
    const { examId } = req.params;
    connection = await oracledb.getConnection(dbConfig);
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
      return res.status(404).json({ 
        message: "❌ Examination not found" 
      });
    }

    const row = result.rows[0];
    
    // معالجة بيانات CLOB
    let examData = {};
    let screeningData = {};
    let dentalFormData = {};
    
    try {
      if (row.EXAM_DATA_TEXT) {
        examData = JSON.parse(row.EXAM_DATA_TEXT);
      }
    } catch (e) {
    }
    
    try {
      if (row.SCREENING_DATA_TEXT) {
        screeningData = JSON.parse(row.SCREENING_DATA_TEXT);
      }
    } catch (e) {
    }
    
    try {
      if (row.DENTAL_FORM_DATA_TEXT) {
        dentalFormData = JSON.parse(row.DENTAL_FORM_DATA_TEXT);
      }
    } catch (e) {
    }

    const examinationDetails = {
      EXAM_ID: row.EXAM_ID,
      PATIENT_UID: row.PATIENT_UID,
      DOCTOR_ID: row.DOCTOR_ID,
      EXAM_DATE: row.EXAM_DATE,
      NOTES: row.NOTES,
      EXAM_DATA: examData,
      SCREENING_DATA: screeningData,
      DENTAL_FORM_DATA: dentalFormData,
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
      DOCTOR_DATA: {
        FULL_NAME: row.DOCTOR_NAME
      }
    };
    res.status(200).json(examinationDetails);

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

// 47. 
app.get("/all-examinations-full", async (req, res) => {
  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);


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
        p.IDIMAGE,    -- ✅ أضف هذا الحقل
        p.IQRAR,      -- ✅ أضف هذا الحقل  
        p.IMAGE,      -- ✅ أضف هذا الحقل
        u.FULL_NAME as DOCTOR_NAME
      FROM EXAMINATIONS e
      LEFT JOIN PATIENTS p ON e.PATIENT_UID = p.PATIENT_UID
      LEFT JOIN USERS u ON e.DOCTOR_ID = u.USER_ID
      ORDER BY e.EXAM_DATE DESC
    `;

    const result = await connection.execute(sql, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });

    if (!result.rows || result.rows.length === 0) {
      return res.status(200).json([]);
    }


    const examinations = [];

    for (let i = 0; i < result.rows.length; i++) {
      const row = result.rows[i];
      
      try {
        // 🔥 تنظيف NOTES field
        const cleanedNotes = cleanNotesField(row.NOTES);

        // جلب بيانات CLOB لهذا السجل
        const clobSql = `
          SELECT 
            EXAM_DATA,
            SCREENING_DATA, 
            DENTAL_FORM_DATA
          FROM EXAMINATIONS 
          WHERE EXAM_ID = :examId
        `;

        const clobResult = await connection.execute(
          clobSql, 
          { examId: row.EXAM_ID }, 
          { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );

        let examData = {};
        let screeningData = {};
        let dentalFormData = {};

        if (clobResult.rows && clobResult.rows.length > 0) {
          const clobRow = clobResult.rows[0];
          
          // استخراج النص من CLOB
          const examDataText = await extractClobText(clobRow.EXAM_DATA);
          const screeningDataText = await extractClobText(clobRow.SCREENING_DATA);
          const dentalFormDataText = await extractClobText(clobRow.DENTAL_FORM_DATA);

          // 🔥 استخدام الدالة الجديدة لتحليل JSON المزدوج
          try {
            if (examDataText && examDataText.trim()) {
              examData = parseDoubleEncodedJSON(examDataText);
            }
          } catch (e) {
            examData = { error: e.message };
          }

          try {
            if (screeningDataText && screeningDataText.trim()) {
              screeningData = parseDoubleEncodedJSON(screeningDataText);
            }
          } catch (e) {
            screeningData = { error: e.message };
          }

          try {
            if (dentalFormDataText && dentalFormDataText.trim()) {
              dentalFormData = parseDoubleEncodedJSON(dentalFormDataText);
            }
          } catch (e) {
            dentalFormData = { error: e.message };
          }
        }

        const exam = {
          EXAM_ID: row.EXAM_ID,
          PATIENT_UID: row.PATIENT_UID,
          DOCTOR_ID: row.DOCTOR_ID,
          EXAM_DATE: row.EXAM_DATE,
          NOTES: cleanedNotes,
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
            IDIMAGE: row.IDIMAGE,    // ✅ أضف هذا
            IQRAR: row.IQRAR,        // ✅ أضف هذا
            IMAGE: row.IMAGE         // ✅ أضف هذا
          },
          DOCTOR_DATA: {
            USER_ID: row.DOCTOR_ID,
            FULL_NAME: row.DOCTOR_NAME
          },
          EXAM_DATA: examData,
          SCREENING_DATA: screeningData,
          DENTAL_FORM_DATA: dentalFormData
        };

        examinations.push(exam);
      } catch (rowError) {
        console.error(`❌ خطأ في معالجة الصف ${i}:`, rowError);
        continue;
      }
    }

    res.status(200).json(examinations);

  } catch (err) {
    console.error("❌ Error fetching all examinations full:", err);
    res.status(500).json({ 
      message: "❌ Error fetching examinations", 
      error: err.message 
    });
  } finally {
    if (connection) await connection.close();
  }
});

// 48. Get examination by patient ID - المُحسَّن
app.get("/examinations/:patientId", async (req, res) => {
  const { patientId } = req.params;
  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);

    const result = await connection.execute(
      `SELECT * FROM examinations WHERE patient_uid = :patientId ORDER BY exam_date DESC`,
      { patientId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (!result.rows || result.rows.length === 0) {
      return res.status(404).json({ 
        message: "❌ No examinations found for this patient",
        patientId 
      });
    }

    // Parse JSON data from CLOB fields - المُحسَّن
    const examinations = result.rows.map(row => {
      const exam = {
        exam_id: row.EXAM_ID,
        patient_uid: row.PATIENT_UID,
        doctor_id: row.DOCTOR_ID,
        exam_date: row.EXAM_DATE,
        notes: cleanNotesField(row.NOTES)
      };

      // Parse JSON fields safely using the new function
      try {
        if (row.EXAM_DATA) {
          const examDataStr = typeof row.EXAM_DATA === 'object' ? row.EXAM_DATA.toString() : row.EXAM_DATA;
          exam.exam_data = parseDoubleEncodedJSON(examDataStr);
        }
      } catch (e) {
        exam.exam_data = { error: e.message };
      }
      
      try {
        if (row.SCREENING_DATA) {
          const screeningDataStr = typeof row.SCREENING_DATA === 'object' ? row.SCREENING_DATA.toString() : row.SCREENING_DATA;
          exam.screening_data = parseDoubleEncodedJSON(screeningDataStr);
        }
      } catch (e) {
        exam.screening_data = { error: e.message };
      }
      
      try {
        if (row.DENTAL_FORM_DATA) {
          const dentalFormDataStr = typeof row.DENTAL_FORM_DATA === 'object' ? row.DENTAL_FORM_DATA.toString() : row.DENTAL_FORM_DATA;
          exam.dental_form_data = parseDoubleEncodedJSON(dentalFormDataStr);
        }
      } catch (e) {
        exam.dental_form_data = { error: e.message };
      }

      return exam;
    });

    res.status(200).json(examinations[0]); // Return the latest examination
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

// 49. Get all examinations - المُحسَّن
app.get("/all-examinations", async (req, res) => {
  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);

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
        u.IMAGE as DOCTOR_IMAGE
      FROM EXAMINATIONS e
      LEFT JOIN PATIENTS p ON e.PATIENT_UID = p.PATIENT_UID
      LEFT JOIN USERS u ON e.DOCTOR_ID = u.USER_ID
      ORDER BY e.EXAM_DATE DESC
    `;

    const result = await connection.execute(
      sql,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (!result.rows || result.rows.length === 0) {
      return res.status(404).json({ 
        message: "❌ No examinations found" 
      });
    }
    const examinations = result.rows.map(row => {
      const exam = {
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
        }
      };

      // Handle CLOB fields safely using the new function
      const handleClobField = (clobData, fieldName) => {
        if (!clobData) return null;
        
        try {
          // If it's a CLOB object, extract the string
          let dataString;
          if (typeof clobData === 'object' && clobData !== null) {
            // Try different CLOB extraction methods
            if (clobData.toString && clobData.toString !== Object.prototype.toString) {
              dataString = clobData.toString();
            } else if (clobData.reader) {
              dataString = clobData.reader.toString();
            } else {
              return null;
            }
          } else if (typeof clobData === 'string') {
            dataString = clobData;
          } else {
            return null;
          }

          // Clean the string and parse JSON using the new function
          if (dataString && dataString.trim() !== '') {
            return parseDoubleEncodedJSON(dataString);
          }
          return null;
        } catch (e) {
          console.error(`❌ Error parsing ${fieldName}:`, e.message);
          return { error: e.message };
        }
      };

      // Parse CLOB fields
      exam.EXAM_DATA = handleClobField(row.EXAM_DATA, 'EXAM_DATA');
      exam.SCREENING_DATA = handleClobField(row.SCREENING_DATA, 'SCREENING_DATA');
      exam.DENTAL_FORM_DATA = handleClobField(row.DENTAL_FORM_DATA, 'DENTAL_FORM_DATA');

      return exam;
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
app.get("/examination-full/:examId", async (req, res) => {
  let connection;
  try {
    const { examId } = req.params;
    connection = await oracledb.getConnection(dbConfig);

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
      return res.status(404).json({ 
        message: "❌ Examination not found" 
      });
    }

    const row = result.rows[0];
    
    // معالجة جميع حقول CLOB باستخدام الدالة الجديدة
    let examData = {};
    let screeningData = {};
    let dentalFormData = {};
    
    try {
      if (row.EXAM_DATA_TEXT) {
        examData = parseDoubleEncodedJSON(row.EXAM_DATA_TEXT);
      }
    } catch (e) {
      examData = { error: e.message };
    }
    
    try {
      if (row.SCREENING_DATA_TEXT) {
        screeningData = parseDoubleEncodedJSON(row.SCREENING_DATA_TEXT);
      }
    } catch (e) {
      screeningData = { error: e.message };
    }
    
    try {
      if (row.DENTAL_FORM_DATA_TEXT) {
        dentalFormData = parseDoubleEncodedJSON(row.DENTAL_FORM_DATA_TEXT);
      }
    } catch (e) {
      dentalFormData = { error: e.message };
    }

    const response = {
      EXAM_ID: row.EXAM_ID,
      PATIENT_UID: row.PATIENT_UID,
      DOCTOR_ID: row.DOCTOR_ID,
      EXAM_DATE: row.EXAM_DATE,
      NOTES: cleanNotesField(row.NOTES),
      EXAM_DATA: examData,
      SCREENING_DATA: screeningData,
      DENTAL_FORM_DATA: dentalFormData
    };

    res.status(200).json(response);
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
// 51. أضف هذا الكود للسيرفر:
app.get("/xray_requests", async (req, res) => {
  let connection;
  
  try {
    connection = await oracledb.getConnection(dbConfig);

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
        -- استخراج النص من CLOB
        CASE 
          WHEN GROUP_TEETH IS NOT NULL THEN DBMS_LOB.SUBSTR(GROUP_TEETH, 4000, 1)
          ELSE NULL
        END as group_teeth,
        CASE 
          WHEN PERIAPICAL_TEETH IS NOT NULL THEN DBMS_LOB.SUBSTR(PERIAPICAL_TEETH, 4000, 1)
          ELSE NULL
        END as periapical_teeth,
        CASE 
          WHEN BITEWING_TEETH IS NOT NULL THEN DBMS_LOB.SUBSTR(BITEWING_TEETH, 4000, 1)
          ELSE NULL
        END as bitewing_teeth,
        TO_CHAR(TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') as timestamp,
        STATUS as status,
        DOCTOR_NAME as doctor_name,
        CLINIC as clinic,
        DOCTOR_UID as doctor_uid,
        TO_CHAR(CREATED_AT, 'YYYY-MM-DD HH24:MI:SS') as created_at
      FROM XRAY_REQUESTS 
      WHERE STATUS = 'pending'
      ORDER BY CREATED_AT DESC
    `;

    const result = await connection.execute(query, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    const requests = result.rows.map(row => {
      const request = { ...row };
      
      // تحويل النص إلى JSON إذا كان موجوداً
      const parseClobField = (clobText) => {
        if (!clobText) return [];
        try {
          return JSON.parse(clobText);
        } catch (e) {
          return [];
        }
      };

      request.group_teeth = parseClobField(row.group_teeth);
      request.periapical_teeth = parseClobField(row.periapical_teeth);
      request.bitewing_teeth = parseClobField(row.bitewing_teeth);

      return request;
    });

    res.status(200).json(requests);

  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ message: "❌ Error", error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

// 52. إصلاح endpoint تحديث حالة طلب الأشعة
app.put("/xray_requests/:requestId/status", async (req, res) => {
  const { requestId } = req.params;
  const { status, completedAt, completedBy } = req.body;


  if (!status) {
    return res.status(400).json({ message: "❌ Status is required" });
  }

  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);

    let sql;
    let bindValues;

    if (status === 'completed') {
      // إذا كانت الحالة completed، أضف حقول completed_at و completed_by
      sql = `
        UPDATE XRAY_REQUESTS 
        SET STATUS = :status, 
            COMPLETED_AT = TO_TIMESTAMP(:completedAt, 'YYYY-MM-DD"T"HH24:MI:SS.FF3"Z"'),
            COMPLETED_BY = :completedBy
        WHERE REQUEST_ID = :requestId
      `;
      bindValues = {
        status: status,
        completedAt: completedAt || new Date().toISOString(),
        completedBy: completedBy || 'فني الأشعة',
        requestId: requestId
      };
    } else {
      // للحالات الأخرى، حدث الحالة فقط
      sql = `UPDATE XRAY_REQUESTS SET STATUS = :status WHERE REQUEST_ID = :requestId`;
      bindValues = { status: status, requestId: requestId };
    }

    const result = await connection.execute(sql, bindValues, { autoCommit: true });

    if (result.rowsAffected === 0) {
      return res.status(404).json({ message: "❌ X-ray request not found" });
    }
    res.status(200).json({ 
      message: "✅ X-ray request status updated successfully",
      requestId: requestId,
      newStatus: status
    });

  } catch (err) {
    console.error("❌ Error updating xray request status:", err);
    res.status(500).json({ 
      message: "❌ Error updating xray request status", 
      error: err.message,
      errorCode: err.errorNum
    });
  } finally {
    if (connection) await connection.close();
  }
});

// 53. رفع صورة الأشعة
app.post("/xray_images", async (req, res) => {
  const {
    request_id,
    patient_id,
    patient_name,
    xray_type,
    image_data,
    uploaded_at,
    uploaded_by
  } = req.body;

  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);

    const sql = `
      INSERT INTO xray_images (
        image_id, request_id, patient_id, patient_name, xray_type,
        image_data, uploaded_at, uploaded_by
      ) VALUES (
        :image_id, :request_id, :patient_id, :patient_name, :xray_type,
        :image_data, TO_TIMESTAMP(:uploaded_at, 'YYYY-MM-DD"T"HH24:MI:SS.FF3"Z"'), :uploaded_by
      )
    `;

    const bindValues = {
      image_id: `IMG_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      request_id,
      patient_id,
      patient_name,
      xray_type,
      image_data,
      uploaded_at,
      uploaded_by
    };

    const result = await connection.execute(sql, bindValues, { autoCommit: true });

    res.status(201).json({ 
      message: "✅ X-ray image uploaded successfully",
      imageId: bindValues.image_id,
      rowsAffected: result.rowsAffected
    });
  } catch (err) {
    console.error("❌ Error uploading xray image:", err);
    res.status(500).json({ message: "❌ Error uploading xray image", error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

// 54. التقرير اليومي للأشعة
app.post("/xray_daily_reports", async (req, res) => {
  const reportData = req.body;

  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);

    const sql = `
      INSERT INTO xray_daily_reports (
        report_id, date, patient_name, patient_id, xray_type,
        clinic, student_name, student_year, doctor_name,
        completed_at, technician_name
      ) VALUES (
        :report_id, TO_DATE(:date, 'YYYY-MM-DD'), :patient_name, :patient_id, :xray_type,
        :clinic, :student_name, :student_year, :doctor_name,
        TO_TIMESTAMP(:completed_at, 'YYYY-MM-DD"T"HH24:MI:SS.FF3"Z"'), :technician_name
      )
    `;

    const bindValues = {
      report_id: `REP_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      ...reportData
    };

    const result = await connection.execute(sql, bindValues, { autoCommit: true });

    res.status(201).json({ 
      message: "✅ Daily report added successfully",
      reportId: bindValues.report_id,
      rowsAffected: result.rowsAffected
    });
  } catch (err) {
    console.error("❌ Error adding daily report:", err);
    res.status(500).json({ message: "❌ Error adding daily report", error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

// 55. بيانات فني الأشعة
app.get("/radiology/profile", async (req, res) => {
  // هذا مثال - عدله حسب نظام المصادقة الخاص بك
  res.status(200).json({
    firstName: "فني",
    fatherName: "الأشعة",
    familyName: "",
    image: ""
  });
});

// 56. Get all students with user data - NEEDS UPDATE
app.get("/students-with-users", async (req, res) => {
  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);

    const result = await connection.execute(
      `SELECT 
        u.USER_ID,
        u.FIRST_NAME,
        u.FATHER_NAME, 
        u.GRANDFATHER_NAME,
        u.FAMILY_NAME,
        u.FULL_NAME,
        u.USERNAME,
        u.EMAIL,
        u.ROLE,
        u.IS_ACTIVE,
        u.CREATED_AT,
        s.STUDENT_UNIVERSITY_ID,
        s.STUDY_YEAR
       FROM USERS u
       INNER JOIN STUDENTS s ON u.USER_ID = s.USER_ID
       WHERE u.ROLE LIKE '%dental_student%' OR u.ROLE LIKE '%طالب%'
       ORDER BY u.FULL_NAME`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    
    const students = result.rows.map(student => {
      // بناء الاسم الكامل إذا لم يكن موجوداً
      let fullName = student.FULL_NAME;
      if (!fullName || fullName.trim() === '') {
        const nameParts = [
          student.FIRST_NAME,
          student.FATHER_NAME, 
          student.GRANDFATHER_NAME,
          student.FAMILY_NAME
        ].filter(part => part && part.trim() !== '');
        fullName = nameParts.join(' ');
      }

      return {
        // بيانات من USERS
        id: student.USER_ID,
        userId: student.USER_ID,
        firstName: student.FIRST_NAME || '',
        fatherName: student.FATHER_NAME || '',
        grandfatherName: student.GRANDFATHER_NAME || '',
        familyName: student.FAMILY_NAME || '',
        fullName: fullName,
        username: student.USERNAME || '',
        email: student.EMAIL || '',
        role: student.ROLE || '',
        isActive: student.IS_ACTIVE,
        createdAt: student.CREATED_AT,
        
        // بيانات من STUDENTS
        universityId: student.STUDENT_UNIVERSITY_ID || '',
        studentUniversityId: student.STUDENT_UNIVERSITY_ID || '',
        studyYear: student.STUDY_YEAR ?? null
      };
    });

    res.status(200).json(students);
  } catch (err) {
    console.error("❌ Error fetching students with users:", err);
    res.status(500).json({ 
      message: "❌ Error fetching students", 
      error: err.message 
    });
  } finally {
    if (connection) await connection.close();
  }
});

// 57. الحل النهائي - استعلام بدون حقول CLOB
app.get("/xray_requests", async (req, res) => {
  let connection;
    
  try {
    connection = await oracledb.getConnection(dbConfig);

    // استعلام آمن بدون حقول CLOB
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
        TO_CHAR(TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') as timestamp,
        STATUS as status,
        DOCTOR_NAME as doctor_name,
        CLINIC as clinic,
        DOCTOR_UID as doctor_uid,
        TO_CHAR(CREATED_AT, 'YYYY-MM-DD HH24:MI:SS') as created_at
      FROM XRAY_REQUESTS 
      WHERE STATUS = 'pending'
      ORDER BY CREATED_AT DESC
    `;

    const result = await connection.execute(query, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });

    if (!result.rows || result.rows.length === 0) {
      return res.status(200).json([]);
    }

    // تحويل البيانات بشكل آمن
    const requests = result.rows.map(row => {
      // معالجة خاصة لحقول الأسنان بناءً على نوع الأشعة
      let selectedTeeth = [];
      const xrayType = row.xray_type;
      
      if (xrayType === 'periapical' && row.tooth) {
        selectedTeeth = [row.tooth];
      } else if (xrayType === 'bitewing' && row.side) {
        selectedTeeth = [`${row.jaw}_${row.side}`];
      } else if (xrayType === 'occlusal' && row.occlusal_jaw) {
        selectedTeeth = [row.occlusal_jaw];
      } else if (xrayType === 'cbct' && row.cbct_jaw) {
        selectedTeeth = [row.cbct_jaw];
      }

      return {
        request_id: row.request_id || '',
        patient_id: row.patient_id || '',
        patient_name: row.patient_name || '',
        student_id: row.student_id || '',
        student_name: row.student_name || '',
        student_full_name: row.student_full_name || '',
        student_year: row.student_year ? Number(row.student_year) : null,
        xray_type: xrayType || '',
        jaw: row.jaw || '',
        occlusal_jaw: row.occlusal_jaw || '',
        cbct_jaw: row.cbct_jaw || '',
        side: row.side || '',
        tooth: row.tooth || '',
        timestamp: row.timestamp || '',
        status: row.status || 'pending',
        doctor_name: row.doctor_name || '',
        clinic: row.clinic || '',
        doctor_uid: row.doctor_uid || '',
        created_at: row.created_at || '',
        // حقول الأسنان كقيم افتراضية
        group_teeth: [],
        periapical_teeth: selectedTeeth,
        bitewing_teeth: selectedTeeth
      };
    });

    res.status(200).json(requests);

  } catch (err) {
    console.error("❌ Error in xray requests:", err.message);
    // في حالة الخطأ، أرجع مصفوفة فارغة
    res.status(200).json([]);
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (closeErr) {
        console.error("❌ Error closing connection:", closeErr);
      }
    }
  }
});

// 58. بديل أبسط بدون معالجة CLOB
app.get("/xray_requests_simple", async (req, res) => {
  const { status } = req.query;
  let connection;
    
  try {
    connection = await oracledb.getConnection(dbConfig);

    // استعلام بسيط بدون حقول CLOB
    let query = `
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
        TO_CHAR(TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') as timestamp,
        STATUS as status,
        DOCTOR_NAME as doctor_name,
        CLINIC as clinic,
        DOCTOR_UID as doctor_uid,
        TO_CHAR(CREATED_AT, 'YYYY-MM-DD HH24:MI:SS') as created_at
      FROM XRAY_REQUESTS 
      WHERE STATUS = 'pending'
      ORDER BY CREATED_AT DESC
    `;

    const result = await connection.execute(query, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });

    if (!result.rows || result.rows.length === 0) {
      return res.status(200).json([]);
    }

    // تحويل بسيط للبيانات
    const requests = result.rows.map(row => ({
      request_id: row.request_id,
      patient_id: row.patient_id,
      patient_name: row.patient_name,
      student_id: row.student_id,
      student_name: row.student_name,
      student_full_name: row.student_full_name,
      student_year: row.student_year ? Number(row.student_year) : null,
      xray_type: row.xray_type,
      jaw: row.jaw,
      occlusal_jaw: row.occlusal_jaw,
      cbct_jaw: row.cbct_jaw,
      side: row.side,
      tooth: row.tooth,
      timestamp: row.timestamp,
      status: row.status,
      doctor_name: row.doctor_name,
      clinic: row.clinic,
      doctor_uid: row.doctor_uid,
      created_at: row.created_at,
      // حقول JSON كقيم افتراضية
      group_teeth: [],
      periapical_teeth: [],
      bitewing_teeth: []
    }));

    res.status(200).json(requests);

  } catch (err) {
    console.error("❌ Error in simple xray requests:", err);
    res.status(200).json([]); // دائماً أرجع مصفوفة فارغة في حالة الخطأ
  } finally {
    if (connection) await connection.close();
  }
});
// 59. إصلاح endpoint بيانات فني الأشعة
app.get("/radiology/profile", async (req, res) => {
  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);

    // هذا مثال - عدله حسب نظام المستخدمين لديك
    const result = await connection.execute(
      `SELECT 
        u.USER_ID,
        u.FIRST_NAME as firstName,
        u.FATHER_NAME as fatherName,
        u.GRANDFATHER_NAME as grandfatherName,
        u.FAMILY_NAME as familyName,
        u.FULL_NAME as fullName,
        u.IMAGE as image
       FROM USERS u 
       WHERE u.ROLE LIKE '%radiology%' OR u.ROLE LIKE '%أشعة%'
       AND ROWNUM = 1`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (result.rows && result.rows.length > 0) {
      const user = result.rows[0];
      res.status(200).json({
        firstName: user.firstName || 'فني',
        fatherName: user.fatherName || '',
        grandfatherName: user.grandfatherName || '',
        familyName: user.familyName || 'الأشعة',
        fullName: user.fullName || 'فني الأشعة',
        image: user.image || ''
      });
    } else {
      // بيانات افتراضية إذا لم يوجد فني أشعة
      res.status(200).json({
        firstName: "فني",
        fatherName: "الأشعة",
        grandfatherName: "",
        familyName: "",
        fullName: "فني الأشعة",
        image: ""
      });
    }
  } catch (err) {
    console.error("❌ Error fetching radiology profile:", err);
    // بيانات افتراضية في حالة الخطأ
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


// 60. إضافة عمود CLOUDINARY_URL لجدول XRAY_IMAGES إذا كان موجوداً
app.post("/add-cloudinary-columns", async (req, res) => {
  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);
    
    // التحقق من وجود الجدول أولاً
    const tableCheck = await connection.execute(
      `SELECT COUNT(*) as table_exists FROM user_tables WHERE table_name = 'XRAY_IMAGES'`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (tableCheck.rows[0].TABLE_EXISTS === 0) {
      return res.status(404).json({ message: "❌ XRAY_IMAGES table does not exist" });
    }

    // إضافة الأعمدة إذا لم تكن موجودة
    const alterSQLs = [
      `ALTER TABLE XRAY_IMAGES ADD CLOUDINARY_URL VARCHAR2(500)`,
      `ALTER TABLE XRAY_IMAGES ADD CLOUDINARY_PUBLIC_ID VARCHAR2(200)`,
      `ALTER TABLE XRAY_IMAGES ADD UPLOADED_BY VARCHAR2(200)`,
      `ALTER TABLE XRAY_IMAGES ADD STATUS VARCHAR2(50) DEFAULT 'uploaded'`
    ];

    for (const sql of alterSQLs) {
      try {
        await connection.execute(sql, {}, { autoCommit: false });
      } catch (alterErr) {
        if (alterErr.errorNum === 1430) { // column already exists
        } else {
          throw alterErr;
        }
      }
    }

    await connection.commit();
    res.status(200).json({ message: "✅ Cloudinary columns added successfully" });

  } catch (err) {
    if (connection) await connection.rollback();
    console.error("❌ Error adding cloudinary columns:", err);
    res.status(500).json({ 
      message: "❌ Error adding cloudinary columns", 
      error: err.message 
    });
  } finally {
    if (connection) await connection.close();
  }
});

// 61. Endpoint لرفع الصورة إلى Cloudinary وحفظها في XRAY_IMAGES
app.post("/upload-xray-to-cloudinary", upload.single('file'), async (req, res) => {
  
  if (!req.file) {
    return res.status(400).json({ 
      success: false, 
      error: "لم يتم رفع أي ملف" 
    });
  }

  let connection;
  try {
    // رفع الصورة إلى Cloudinary
    const cloudinaryResult = await cloudinary.uploader.upload(req.file.path, {
      folder: 'dental_xrays',
      resource_type: 'image',
      quality: 'auto:good',
      format: 'jpg'
    });

    const fs = require('fs');
    fs.unlinkSync(req.file.path);

    // الحصول على البيانات من body
    const {
      patientId,
      patientName,
      xrayType,
      requestId,
      studentId,
      uploadedBy = 'student'
    } = req.body;


    connection = await oracledb.getConnection(dbConfig);

    const insertSQL = `
      INSERT INTO XRAY_IMAGES (
        IMAGE_ID,
        REQUEST_ID,
        PATIENT_ID,
        PATIENT_NAME,
        STUDENT_ID,
        STUDENT_NAME,
        XRAY_TYPE,
        CLOUDINARY_URL,
        CLOUDINARY_PUBLIC_ID,
        UPLOADED_AT,
        UPLOADED_BY,
        STATUS
      ) VALUES (
        :image_id,
        :request_id,
        :patient_id,
        :patient_name,
        :student_id,
        :student_name,
        :xray_type,
        :cloudinary_url,
        :cloudinary_public_id,
        SYSTIMESTAMP,
        :uploaded_by,
        'uploaded'
      )
    `;

    // جلب اسم الطالب إذا كان studentId موجوداً
    let studentName = 'طالب';
    if (studentId) {
      try {
        const studentResult = await connection.execute(
          `SELECT FULL_NAME FROM USERS WHERE USER_ID = :student_id`,
          { student_id: studentId },
          { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        if (studentResult.rows.length > 0) {
          studentName = studentResult.rows[0].FULL_NAME || 'طالب';
        }
      } catch (nameErr) {
      }
    }

    const bindValues = {
      image_id: `IMG_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      request_id: requestId,
      patient_id: patientId,
      patient_name: patientName,
      student_id: studentId,
      student_name: studentName,
      xray_type: xrayType,
      cloudinary_url: cloudinaryResult.secure_url,
      cloudinary_public_id: cloudinaryResult.public_id,
      uploaded_by: uploadedBy
    };

    const result = await connection.execute(insertSQL, bindValues, { autoCommit: true });
    // تحديث حالة طلب الأشعة إلى "completed"
    if (requestId) {
      try {
        await connection.execute(
          `UPDATE XRAY_REQUESTS SET STATUS = 'completed', COMPLETED_AT = SYSTIMESTAMP WHERE REQUEST_ID = :request_id`,
          { request_id: requestId },
          { autoCommit: true }
        );
      } catch (updateErr) {
      }
    }

    res.status(200).json({
      success: true,
      message: "✅ تم رفع صورة الأشعة بنجاح",
      imageId: bindValues.image_id,
      cloudinaryUrl: cloudinaryResult.secure_url,
      publicId: cloudinaryResult.public_id,
      rowsAffected: result.rowsAffected
    });

  } catch (err) {
    console.error("❌ Error uploading to cloudinary:", err);
    
    // تنظيف الملف المؤقت في حالة الخطأ
    if (req.file) {
      const fs = require('fs');
      try {
        fs.unlinkSync(req.file.path);
      } catch (unlinkErr) {
        console.error("❌ Error deleting temp file:", unlinkErr);
      }
    }
    
    res.status(500).json({
      success: false,
      error: "فشل رفع الصورة",
      details: err.message
    });
  } finally {
    if (connection) await connection.close();
  }
});

// 62. جلب الصور المرفوعة لمريض معين
app.get("/xray-images/patient/:patientId", async (req, res) => {
  const { patientId } = req.params;
  let connection;
  
  try {
    connection = await oracledb.getConnection(dbConfig);

    // استعلام محسّن - أكثر مرونة
    const query = `
      SELECT 
        STUDENT_NAME as student_name,
        XRAY_TYPE as xray_type,
        CLOUDINARY_URL as image_url,
        TO_CHAR(CREATED_AT, 'YYYY-MM-DD HH24:MI:SS') as uploaded_at
      FROM XRAY_REQUESTS 
      WHERE PATIENT_ID = :patient_id
        AND CLOUDINARY_URL IS NOT NULL
        AND CLOUDINARY_URL != 'null'
        AND (UPPER(STATUS) = 'COMPLETED' OR STATUS = 'completed' OR STATUS IS NULL)
      ORDER BY CREATED_AT DESC
    `;

    const result = await connection.execute(
      query,
      { patient_id: patientId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    // طباعة تفاصيل النتائج
    if (result.rows.length > 0) {
      result.rows.forEach((row, index) => {
      });
    } else {

    }

    res.status(200).json(result.rows);

  } catch (err) {
    console.error("❌ Error fetching patient xray images:", err);  
    
    const data = realData[patientId] || [];
    res.status(200).json(data);
  } finally {
    if (connection) await connection.close();
  }
});
// 63. جلب الصور المرفوعة لطلب معين
app.get("/xray-images/request/:requestId", async (req, res) => {
  const { requestId } = req.params;
  let connection;
  
  try {
    connection = await oracledb.getConnection(dbConfig);

    const query = `
      SELECT 
        IMAGE_ID,
        REQUEST_ID,
        PATIENT_NAME,
        STUDENT_NAME,
        XRAY_TYPE,
        CLOUDINARY_URL,
        CLOUDINARY_PUBLIC_ID,
        TO_CHAR(UPLOADED_AT, 'YYYY-MM-DD HH24:MI:SS') as UPLOADED_AT,
        UPLOADED_BY,
        STATUS
      FROM XRAY_IMAGES
      WHERE REQUEST_ID = :request_id
      ORDER BY UPLOADED_AT DESC
    `;

    const result = await connection.execute(
      query,
      { request_id: requestId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );


    res.status(200).json(result.rows);

  } catch (err) {
    console.error("❌ Error fetching request xray images:", err);
    res.status(500).json({ 
      message: "❌ Error fetching request images", 
      error: err.message 
    });
  } finally {
    if (connection) await connection.close();
  }
});

// 64. حذف صورة أشعة (للمشرفين)
app.delete("/xray-images/:imageId", async (req, res) => {
  const { imageId } = req.params;
  let connection;
  
  try {
    connection = await oracledb.getConnection(dbConfig);

    // جلب public_id من قاعدة البيانات أولاً
    const selectResult = await connection.execute(
      `SELECT CLOUDINARY_PUBLIC_ID FROM XRAY_IMAGES WHERE IMAGE_ID = :image_id`,
      { image_id: imageId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (!selectResult.rows || selectResult.rows.length === 0) {
      return res.status(404).json({ message: "❌ Image not found" });
    }

    const publicId = selectResult.rows[0].CLOUDINARY_PUBLIC_ID;

    // حذف الصورة من Cloudinary
    if (publicId) {
      try {
        await cloudinary.uploader.destroy(publicId);
      } catch (cloudinaryErr) {
        console.error("❌ Error deleting from Cloudinary:", cloudinaryErr);
      }
    }

    // حذف السجل من قاعدة البيانات
    const deleteResult = await connection.execute(
      `DELETE FROM XRAY_IMAGES WHERE IMAGE_ID = :image_id`,
      { image_id: imageId },
      { autoCommit: true }
    );

    if (deleteResult.rowsAffected === 0) {
      return res.status(404).json({ message: "❌ Image not found" });
    }

    res.status(200).json({ 
      message: "✅ تم حذف صورة الأشعة بنجاح",
      imageId: imageId
    });

  } catch (err) {
    console.error("❌ Error deleting xray image:", err);
    res.status(500).json({ 
      message: "❌ Error deleting image", 
      error: err.message 
    });
  } finally {
    if (connection) await connection.close();
  }
});

//65. 
app.get("/check-xray-requests", async (req, res) => {
  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);

    const query = `
      SELECT 
        REQUEST_ID,
        PATIENT_ID,
        PATIENT_NAME,
        STUDENT_NAME,
        XRAY_TYPE,
        CLOUDINARY_URL,
        STATUS,
        TO_CHAR(CREATED_AT, 'YYYY-MM-DD HH24:MI:SS') as CREATED_AT
      FROM XRAY_REQUESTS 
      ORDER BY CREATED_AT DESC
    `;

    const result = await connection.execute(query, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });

    result.rows.forEach((row, index) => {
    });

    res.json({ requests: result.rows });

  } catch (err) {
    console.error("❌ Error checking requests:", err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

// 66. NEW ENDPOINT: Add xray request - INCLUDES CLINIC AND DOCTOR_UID
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
    clinic,           // ← العمود الجديد
    doctorUid         // ← العمود الجديد
  } = req.body;

  if (!patientId || !patientName || !xrayType) {
    return res.status(400).json({ 
      message: "❌ Missing required fields",
      required: ['patientId', 'patientName', 'xrayType']
    });
  }

  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);

    const requestId = `XR_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // SQL query محدثة لتشمل العمودين الجداد CLINIC و DOCTOR_UID
    const query = `
      INSERT INTO XRAY_REQUESTS (
        REQUEST_ID, PATIENT_ID, PATIENT_NAME, STUDENT_ID, STUDENT_NAME,
        STUDENT_FULL_NAME, STUDENT_YEAR, XRAY_TYPE, JAW, OCCLUSAL_JAW,
        CBCT_JAW, SIDE, TOOTH, GROUP_TEETH, PERIAPICAL_TEETH, BITEWING_TEETH,
        DOCTOR_NAME, CLINIC, DOCTOR_UID, CREATED_AT, STATUS, TIMESTAMP
      ) VALUES (
        :request_id, :patient_id, :patient_name, :student_id, :student_name,
        :student_full_name, :student_year, :xray_type, :jaw, :occlusal_jaw,
        :cbct_jaw, :side, :tooth, :group_teeth, :periapical_teeth, :bitewing_teeth,
        :doctor_name, :clinic, :doctor_uid, SYSTIMESTAMP, 'pending', SYSTIMESTAMP
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
      clinic: clinic || null,           // ← العمود الجديد
      doctor_uid: doctorUid || null     // ← العمود الجديد
    };


    const result = await connection.execute(query, values, { autoCommit: true });

    res.status(201).json({ 
      message: 'تم إرسال طلب الأشعة بنجاح',
      requestId: requestId,
      rowsAffected: result.rowsAffected
    });

  } catch (error) {
    console.error('❌ Error inserting xray request:', error);
    
    let errorMessage = 'فشل إرسال الطلب';
    if (error.errorNum === 1) {
      errorMessage = 'رقم الطلب مكرر';
    } else if (error.errorNum === 1400) {
      errorMessage = 'حقول مطلوبة مفقودة';
    }
    
    res.status(500).json({ 
      error: errorMessage,
      details: error.message 
    });
  } finally {
    if (connection) await connection.close();
  }
});
// 67. GET endpoint لجلب طلبات الطالب - معدل
app.get('/student-xray-requests/:studentId', async (req, res) => {
  const { studentId } = req.params;

  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);
    
    // استعلام لجلب الطلبات المكتملة فقط
    const query = `
      SELECT 
        REQUEST_ID,
        PATIENT_ID,
        PATIENT_NAME,
        STUDENT_ID,
        STUDENT_NAME,
        XRAY_TYPE,
        JAW,
        SIDE,
        TOOTH,
        CLINIC,
        DOCTOR_NAME,
        TO_CHAR(CREATED_AT, 'YYYY-MM-DD HH24:MI:SS') AS CREATED_AT,
        STATUS,
        CLOUDINARY_URL
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

    const requests = result.rows.map(row => ({
      request_id: row.REQUEST_ID,
      patient_id: row.PATIENT_ID,
      patient_name: row.PATIENT_NAME,
      student_id: row.STUDENT_ID,
      student_name: row.STUDENT_NAME,
      xray_type: row.XRAY_TYPE,
      jaw: row.JAW,
      side: row.SIDE,
      tooth: row.TOOTH,
      clinic: row.CLINIC,
      doctor_name: row.DOCTOR_NAME,
      created_at: row.CREATED_AT,
      status: row.STATUS,
      cloudinary_url: row.CLOUDINARY_URL
    }));

    res.json({
      success: true,
      data: requests
    });
    
  } catch (error) {
    console.error('Error fetching student xray requests:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (closeErr) {
        console.error('Error closing connection:', closeErr);
      }
    }
  }
});
//68. 
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

    connection = await oracledb.getConnection(dbConfig);

    const updateSQL = `
      UPDATE XRAY_REQUESTS 
      SET 
        CLOUDINARY_URL = :image_url,
        STATUS = 'completed',
        COMPLETED_AT = SYSTIMESTAMP,
        COMPLETED_BY = :student_id
      WHERE REQUEST_ID = :request_id
    `;

    const bindValues = {
      image_url: imageUrl,
      student_id: studentId,
      request_id: requestId
    };

    const result = await connection.execute(updateSQL, bindValues, { autoCommit: true });

    if (result.rowsAffected === 0) {
      return res.status(404).json({
        success: false,
        error: "لم يتم العثور على الطلب"
      });
    }

    res.status(200).json({
      success: true,
      message: "✅ تم تحديث صورة الأشعة بنجاح",
      requestId: requestId,
      cloudinaryUrl: imageUrl,
      rowsAffected: result.rowsAffected
    });

  } catch (err) {
    console.error("❌ Error updating xray image url:", err);
    res.status(500).json({
      success: false,
      error: "فشل تحديث رابط الصورة",
      details: err.message
    });
  } finally {
    if (connection) await connection.close();
  }
});

// 69. GET endpoint لجلب طلبات الطالب
app.get('/api/student-xray-requests/:studentId', async (req, res) => {
  const { studentId } = req.params;

  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);
    
    // استعلام لجلب الطلبات المنتظرة فقط
    const query = `
      SELECT 
        REQUEST_ID,
        PATIENT_ID,
        PATIENT_NAME,
        STUDENT_ID,
        STUDENT_NAME,
        XRAY_TYPE,
        JAW,
        SIDE,
        TOOTH,
        CLINIC,
        DOCTOR_NAME,
        TO_CHAR(CREATED_AT, 'YYYY-MM-DD HH24:MI:SS') AS CREATED_AT,
        STATUS,
        CLOUDINARY_URL,
        CASE WHEN CLOUDINARY_URL IS NOT NULL THEN 1 ELSE 0 END as IS_UPLOADED
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

    const requests = result.rows.map(row => ({
      request_id: row.REQUEST_ID,
      patient_id: row.PATIENT_ID,
      patient_name: row.PATIENT_NAME,
      student_id: row.STUDENT_ID,
      student_name: row.STUDENT_NAME,
      xray_type: row.XRAY_TYPE,
      jaw: row.JAW,
      side: row.SIDE,
      tooth: row.TOOTH,
      clinic: row.CLINIC,
      doctor_name: row.DOCTOR_NAME,
      created_at: row.CREATED_AT,
      status: row.STATUS,
      cloudinary_url: row.CLOUDINARY_URL,
      is_uploaded: row.IS_UPLOADED === 1
    }));

    res.json({
      success: true,
      data: requests
    });
    
  } catch (error) {
    console.error('Error fetching student xray requests:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (closeErr) {
        console.error('Error closing connection:', closeErr);
      }
    }
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
    connection = await oracledb.getConnection(dbConfig);

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
      PROCEDURE_ID: PROCEDURE_ID,
      CLINIC_NAME: CLINIC_NAME || null,
      DATE_OF_OPERATION: DATE_OF_OPERATION || null,
      DATE_OF_SECOND_VISIT: DATE_OF_SECOND_VISIT || null,
      PATIENT_ID: PATIENT_ID || null,
      PATIENT_ID_NUMBER: PATIENT_ID_NUMBER,
      PATIENT_NAME: PATIENT_NAME,
      STUDENT_NAME: STUDENT_NAME || null,
      SUPERVISOR_NAME: SUPERVISOR_NAME || null,
      TOOTH_NO: TOOTH_NO || null,
      TYPE_OF_OPERATION: TYPE_OF_OPERATION || null
    };


    const result = await connection.execute(sql, bindValues, { autoCommit: true });


    res.status(201).json({ 
      message: "✅ Clinical procedure saved successfully",
      PROCEDURE_ID: PROCEDURE_ID,
      rowsAffected: result.rowsAffected
    });

  } catch (err) {
    console.error("❌ Error saving clinical procedure:", err);
    
    let errorMessage = "❌ Error saving clinical procedure";
    if (err.errorNum === 1) {
      errorMessage = "❌ Procedure ID already exists";
    } else if (err.errorNum === 1847 || err.errorNum === 1861) {
      errorMessage = "❌ Invalid date format. Use YYYY-MM-DD";
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

// 71. Get clinical procedures by patient ID
app.get("/clinical_procedures/patient/:patientId", async (req, res) => {
  const { patientId } = req.params;
  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);

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
    connection = await oracledb.getConnection(dbConfig);

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

    const sql = `UPDATE CLINICAL_PROCEDURES SET ${setClause.join(', ')} WHERE PROCEDURE_ID = :procedureId`;

    const result = await connection.execute(sql, bindValues, { autoCommit: true });

    if (result.rowsAffected === 0) {
      return res.status(404).json({ message: "❌ Clinical procedure not found" });
    }


    res.status(200).json({ 
      message: "✅ Clinical procedure updated successfully",
      procedureId: procedureId,
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

// 73. Add new prescription (معدل)
app.post("/prescriptions", async (req, res) => {
  let requestData = {};
  try {
    if (req.body && Object.keys(req.body).length > 0) {
      requestData = req.body;
    }
  } catch (e) {
  }

  const {
    PATIENT_ID,
    PATIENT_NAME,
    MEDICINE_NAME,
    QUANTITY,
    USAGE_TIME,
    DOCTOR_NAME,
    DOCTOR_UID,
    PRESCRIPTION_DATE
  } = requestData;

  if (!PATIENT_ID || !PATIENT_NAME || !MEDICINE_NAME || !DOCTOR_NAME || !DOCTOR_UID) {
    return res.status(400).json({ 
      message: "❌ Missing required fields",
      required: ['PATIENT_ID', 'PATIENT_NAME', 'MEDICINE_NAME', 'DOCTOR_NAME', 'DOCTOR_UID']
    });
  }

  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);

    const sql = `
      INSERT INTO PRESCRIPTIONS (
        PRESCRIPTION_ID,
        PATIENT_ID,
        PATIENT_NAME,
        MEDICINE_NAME,
        QUANTITY,
        USAGE_TIME,
        DOCTOR_NAME,
        DOCTOR_UID,
        CREATED_DATE,
        PRESCRIPTION_DATE
      ) VALUES (
        :PRESCRIPTION_ID,
        :PATIENT_ID,
        :PATIENT_NAME,
        :MEDICINE_NAME,
        :QUANTITY,
        :USAGE_TIME,
        :DOCTOR_NAME,
        :DOCTOR_UID,
        SYSTIMESTAMP,
        TO_DATE(:PRESCRIPTION_DATE, 'YYYY-MM-DD')
      )
    `;

    const bindValues = {
      PRESCRIPTION_ID: `PRESC_${Date.now()}`,
      PATIENT_ID: PATIENT_ID,
      PATIENT_NAME: PATIENT_NAME,
      MEDICINE_NAME: MEDICINE_NAME,
      QUANTITY: QUANTITY || '1',
      USAGE_TIME: USAGE_TIME || null,
      DOCTOR_NAME: DOCTOR_NAME,
      DOCTOR_UID: DOCTOR_UID,
      PRESCRIPTION_DATE: PRESCRIPTION_DATE || new Date().toISOString().split('T')[0]
    };


    const result = await connection.execute(sql, bindValues, { autoCommit: true });


    res.status(201).json({ 
      message: "✅ Prescription saved successfully",
      PRESCRIPTION_ID: bindValues.PRESCRIPTION_ID,
      rowsAffected: result.rowsAffected
    });

  } catch (err) {
    console.error("❌ Error saving prescription:", err);
    
    let errorMessage = "❌ Error saving prescription";
    if (err.errorNum === 1) {
      errorMessage = "❌ Prescription ID already exists";
    } else if (err.errorNum === 1847 || err.errorNum === 1861) {
      errorMessage = "❌ Invalid date format. Use YYYY-MM-DD";
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

// 74.Get prescriptions by patient ID - مصحح
app.get("/prescriptions/patient/:patientId", async (req, res) => {
  const { patientId } = req.params;
  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);

    // طباعة الـ query للتأكد
    const sqlQuery = `
      SELECT 
        PRESCRIPTION_ID,
        PATIENT_ID,
        PATIENT_NAME,
        MEDICINE_NAME,
        QUANTITY,
        USAGE_TIME,
        DOCTOR_NAME,
        DOCTOR_UID,
        TO_CHAR(CREATED_DATE, 'YYYY-MM-DD HH24:MI:SS') as CREATED_DATE,
        TO_CHAR(PRESCRIPTION_DATE, 'YYYY-MM-DD') as PRESCRIPTION_DATE
       FROM PRESCRIPTIONS 
       WHERE PATIENT_ID = :patientId
       ORDER BY CREATED_DATE DESC
    `;


    const result = await connection.execute(
      sqlQuery,
      { patientId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (!result.rows || result.rows.length === 0) {
      return res.status(404).json({ 
        message: "❌ No prescriptions found for this patient",
        patientId 
      });
    }


    res.status(200).json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching patient prescriptions:", err);
    console.error("❌ Error details:", err.message);
    res.status(500).json({ 
      message: "❌ Error fetching patient prescriptions", 
      error: err.message 
    });
  } finally {
    if (connection) await connection.close();
  }
});

// 75. Update prescription (معدل مع التحقق من الصلاحيات)
app.put("/prescriptions/:prescriptionId", async (req, res) => {
  const { prescriptionId } = req.params;
  
  let updateData = {};
  try {
    if (req.body && Object.keys(req.body).length > 0) {
      updateData = req.body;
    }
  } catch (e) {
  }

  const DOCTOR_UID = updateData.DOCTOR_UID;


  if (!updateData || Object.keys(updateData).length === 0) {
    return res.status(400).json({ message: "❌ No data provided for update" });
  }

  if (!DOCTOR_UID) {
    return res.status(400).json({ message: "❌ DOCTOR_UID is required for update" });
  }

  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);

    // التحقق من أن الطبيب هو مالك الوصفة
    const checkOwnership = await connection.execute(
      `SELECT DOCTOR_UID FROM PRESCRIPTIONS WHERE PRESCRIPTION_ID = :prescriptionId`,
      { prescriptionId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (!checkOwnership.rows || checkOwnership.rows.length === 0) {
      return res.status(404).json({ message: "❌ Prescription not found" });
    }

    const prescriptionDoctorUid = checkOwnership.rows[0].DOCTOR_UID;
    
    if (prescriptionDoctorUid !== DOCTOR_UID) {
      return res.status(403).json({ 
        message: "❌ Access denied: You can only update your own prescriptions" 
      });
    }

    const allowedFields = [
      'PATIENT_ID', 'PATIENT_NAME', 'MEDICINE_NAME', 'QUANTITY',
      'USAGE_TIME', 'DOCTOR_NAME', 'PRESCRIPTION_DATE'
    ];

    const setClause = [];
    const bindValues = { prescriptionId };

    allowedFields.forEach(field => {
      if (updateData[field] !== undefined) {
        if (field === 'PRESCRIPTION_DATE') {
          setClause.push(`${field} = TO_DATE(:${field}, 'YYYY-MM-DD')`);
          bindValues[field] = updateData[field];
        } else {
          setClause.push(`${field} = :${field}`);
          bindValues[field] = updateData[field];
        }
      }
    });

    if (setClause.length === 0) {
      return res.status(400).json({ message: "❌ No valid fields to update" });
    }

    const sql = `UPDATE PRESCRIPTIONS SET ${setClause.join(', ')} WHERE PRESCRIPTION_ID = :prescriptionId`;

    const result = await connection.execute(sql, bindValues, { autoCommit: true });


    res.status(200).json({ 
      message: "✅ Prescription updated successfully",
      prescriptionId: prescriptionId,
      updatedFields: setClause
    });

  } catch (err) {
    console.error("❌ Error updating prescription:", err);
    res.status(500).json({ 
      message: "❌ Error updating prescription", 
      error: err.message 
    });
  } finally {
    if (connection) await connection.close();
  }
});

// 76.Delete prescription (معدل مع التحقق من الصلاحيات)
app.delete("/prescriptions/:prescriptionId", async (req, res) => {
  const { prescriptionId } = req.params;
  
  // في طلبات DELETE، نأخذ البيانات من query parameters بدلاً من body
  const DOCTOR_UID = req.query.doctorUid;


  if (!DOCTOR_UID) {
    return res.status(400).json({ message: "❌ DOCTOR_UID is required for deletion" });
  }

  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);

    // التحقق من أن الطبيب هو مالك الوصفة
    const checkOwnership = await connection.execute(
      `SELECT DOCTOR_UID FROM PRESCRIPTIONS WHERE PRESCRIPTION_ID = :prescriptionId`,
      { prescriptionId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (!checkOwnership.rows || checkOwnership.rows.length === 0) {
      return res.status(404).json({ message: "❌ Prescription not found" });
    }

    const prescriptionDoctorUid = checkOwnership.rows[0].DOCTOR_UID;
    
    if (prescriptionDoctorUid !== DOCTOR_UID) {
      return res.status(403).json({ 
        message: "❌ Access denied: You can only delete your own prescriptions" 
      });
    }

    const result = await connection.execute(
      `DELETE FROM PRESCRIPTIONS WHERE PRESCRIPTION_ID = :prescriptionId`,
      { prescriptionId },
      { autoCommit: true }
    );


    res.status(200).json({ 
      message: "✅ Prescription deleted successfully",
      prescriptionId: prescriptionId
    });

  } catch (err) {
    console.error("❌ Error deleting prescription:", err);
    res.status(500).json({ 
      message: "❌ Error deleting prescription", 
      error: err.message 
    });
  } finally {
    if (connection) await connection.close();
  }
});

// 77. جلب جميع التعيينات الحالية - معدل لـ Oracle
app.get('/patient_assignments', async (req, res) => {
  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);

    const result = await connection.execute(
      `SELECT ASSIGNMENT_ID, STUDENT_ID, PATIENT_UID, ASSIGNED_DATE, STATUS
       FROM STUDENT_ASSIGNMENTS 
       WHERE STATUS = 'ACTIVE'`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    res.json(result.rows || []);
  } catch (error) {
    console.error('Error fetching assignments:', error);
    // بدلاً من إرجاع خطأ، نرجع مصفوفة فارغة
    res.json([]);
  } finally {
    if (connection) await connection.close();
  }
});

// 78. تعيين مريض لطالب - معدل للسماح بتعيين متعدد
app.post('/assign_patient_to_student', async (req, res) => {
  let connection;
  try {
    const { patient_id, student_id } = req.body;
    
    if (!patient_id || !student_id) {
      return res.status(400).json({ error: 'patient_id و student_id مطلوبان' });
    }

    connection = await oracledb.getConnection(dbConfig);
    
    // التحقق من وجود المريض
    const patientCheck = await connection.execute(
      'SELECT COUNT(*) as COUNT FROM PATIENTS WHERE PATIENT_UID = :patient_id',
      { patient_id },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (patientCheck.rows[0].COUNT === 0) {
      return res.status(404).json({ error: 'المريض غير موجود' });
    }

    // التحقق من وجود الطالب
    const studentCheck = await connection.execute(
      'SELECT COUNT(*) as COUNT FROM USERS WHERE USER_ID = :student_id',
      { student_id },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (studentCheck.rows[0].COUNT === 0) {
      return res.status(404).json({ error: 'الطالب غير موجود' });
    }
    
    // 🔥 التعديل: السماح بتعيين المريض لطلاب متعددين
    // التحقق فقط من عدم تكرار نفس التعيين (نفس المريض لنفس الطالب)
    const existingCheck = await connection.execute(
      `SELECT ASSIGNMENT_ID FROM STUDENT_ASSIGNMENTS 
       WHERE PATIENT_UID = :patient_id AND STUDENT_ID = :student_id AND STATUS = 'ACTIVE'`,
      { 
        patient_id: patient_id,
        student_id: student_id 
      },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (existingCheck.rows.length > 0) {
      return res.status(400).json({ 
        error: 'المريض معين مسبقاً لهذا الطالب نفسه',
        details: 'يمكن تعيين المريض لطلاب مختلفين، ولكن ليس لنفس الطالب مرتين'
      });
    }
    
    const assignment_id = `ASSIGN_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    await connection.execute(
      `INSERT INTO STUDENT_ASSIGNMENTS (ASSIGNMENT_ID, STUDENT_ID, PATIENT_UID, ASSIGNED_DATE, STATUS) 
       VALUES (:assignment_id, :student_id, :patient_uid, SYSTIMESTAMP, 'ACTIVE')`,
      {
        assignment_id: assignment_id,
        student_id: student_id,
        patient_uid: patient_id
      },
      { autoCommit: true }
    );

    res.status(201).json({ 
      message: 'تم تعيين المريض للطالب بنجاح', 
      assignment_id: assignment_id 
    });
  } catch (error) {
    console.error('Error assigning patient:', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (connection) await connection.close();
  }
});

// 79. إزالة تعيين مريض محدد - DELETES ACTUALLY
app.delete('/remove_patient_assignment/:patientId', async (req, res) => {
  let connection;
  try {
    const { patientId } = req.params;
    
    connection = await oracledb.getConnection(dbConfig);

    // 🔥 تغيير من UPDATE إلى DELETE لحذف فعلي
    const result = await connection.execute(
      `DELETE FROM STUDENT_ASSIGNMENTS 
       WHERE PATIENT_UID = :patient_id AND STATUS = 'ACTIVE'`,
      { patient_id: patientId },
      { autoCommit: true }
    );

    if (result.rowsAffected === 0) {
      return res.status(404).json({ error: 'لم يتم العثور على تعيين فعال لهذا المريض' });
    }
    
    res.json({ 
      message: 'تم حذف تعيين المريض بنجاح',
      rowsAffected: result.rowsAffected 
    });
  } catch (error) {
    console.error('Error deleting assignment:', error);
    res.status(500).json({ error: 'فشل في حذف التعيين' });
  } finally {
    if (connection) await connection.close();
  }
});

// 80. حذف جميع التعيينات - DELETES ACTUALLY
app.delete('/clear_all_assignments', async (req, res) => {
  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);

    // 🔥 تغيير من UPDATE إلى DELETE لحذف فعلي
    const result = await connection.execute(
      `DELETE FROM STUDENT_ASSIGNMENTS WHERE STATUS = 'ACTIVE'`,
      [],
      { autoCommit: true }
    );
    
    res.json({ 
      message: 'تم حذف جميع التعيينات بنجاح',
      rowsAffected: result.rowsAffected 
    });
  } catch (error) {
    console.error('Error clearing assignments:', error);
    res.status(500).json({ error: 'فشل في حذف التعيينات' });
  } finally {
    if (connection) await connection.close();
  }
});

// 81. جلب الطلاب المعينين لمريض محدد - معدل لـ Oracle
app.get('/patient_assignments/:patientId', async (req, res) => {
  let connection;
  try {
    const { patientId } = req.params;
    
    connection = await oracledb.getConnection(dbConfig);

    const result = await connection.execute(
      `SELECT sa.*, u.FIRST_NAME, u.FATHER_NAME, u.GRANDFATHER_NAME, u.FAMILY_NAME, s.STUDENT_UNIVERSITY_ID
       FROM STUDENT_ASSIGNMENTS sa
       LEFT JOIN USERS u ON sa.STUDENT_ID = u.USER_ID
       LEFT JOIN STUDENTS s ON u.USER_ID = s.USER_ID
       WHERE sa.PATIENT_UID = :patient_id AND sa.STATUS = 'ACTIVE'`,
      { patient_id: patientId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching patient assignments:', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (connection) await connection.close();
  }
});
// 82. حذف تعيين طالب محدد لمريض محدد
app.delete('/remove_specific_assignment/:patientId/:studentId', async (req, res) => {
  let connection;
  try {
    const { patientId, studentId } = req.params;
    
    connection = await oracledb.getConnection(dbConfig);

    const result = await connection.execute(
      `DELETE FROM STUDENT_ASSIGNMENTS 
       WHERE PATIENT_UID = :patient_id AND STUDENT_ID = :student_id AND STATUS = 'ACTIVE'`,
      { 
        patient_id: patientId,
        student_id: studentId 
      },
      { autoCommit: true }
    );

    if (result.rowsAffected === 0) {
      return res.status(404).json({ error: 'لم يتم العثور على التعيين المطلوب' });
    }
    
    res.json({ 
      message: 'تم حذف تعيين الطالب للمريض بنجاح',
      rowsAffected: result.rowsAffected 
    });
  } catch (error) {
    console.error('Error deleting specific assignment:', error);
    res.status(500).json({ error: 'فشل في حذف التعيين' });
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
    
    connection = await oracledb.getConnection(dbConfig);
    
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

    connection = await oracledb.getConnection(dbConfig);

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
    connection = await oracledb.getConnection(dbConfig);

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
    connection = await oracledb.getConnection(dbConfig);

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
    connection = await oracledb.getConnection(dbConfig);

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
    connection = await oracledb.getConnection(dbConfig);

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
    connection = await oracledb.getConnection(dbConfig);
    
    const result = await connection.execute(
      `SELECT COUNT(*) AS COUNT FROM PATIENTS WHERE IDNUMBER = :idNumber`,
      { idNumber: parseInt(idNumber) },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const exists = result.rows[0].COUNT > 0;
    
    res.status(200).json({ 
      exists: exists,
      message: exists ? "رقم الهوية مسجل مسبقاً" : "رقم الهوية متاح"
    });
  } catch (err) {
    console.error("❌ Error checking ID in patients:", err);
    res.status(500).json({ 
      message: "❌ Error checking ID", 
      error: err.message 
    });
  } finally {
    if (connection) await connection.close();
  }
});

// 89. Add new patient directly to PATIENTS table
app.post("/patients", async (req, res) => {
  let parsedBody;
  if (!req.body) {
    parsedBody = {};
  } else if (typeof req.body === 'string') {
    try {
      parsedBody = JSON.parse(req.body);
    } catch (e) {
      return res.status(400).json({ message: 'Invalid JSON body' });
    }
  } else {
    parsedBody = req.body;
  }

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
  } = parsedBody;

  // التحقق من الحقول المطلوبة
  if (!firstName || !familyName || !idNumber) {
    return res.status(400).json({ 
      message: "❌ Missing required fields",
      required: ['firstName', 'familyName', 'idNumber']
    });
  }

  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);

    // التحقق من عدم وجود رقم الهوية مسبقاً
    const idCheck = await connection.execute(
      `SELECT COUNT(*) AS COUNT FROM PATIENTS WHERE IDNUMBER = :idNumber`,
      { idNumber: parseInt(idNumber) },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (idCheck.rows[0].COUNT > 0) {
      return res.status(409).json({ 
        message: "❌ رقم الهوية مسجل مسبقاً",
        idNumber: idNumber
      });
    }

    // إنشاء patient_uid (استخدم IDNUMBER كمعرف فريد)
    const patientUid = idNumber.toString();
    const medicalRecordNo = `MR${Date.now().toString().slice(-6)}`;

    // معالجة تاريخ الميلاد
    let birthDateValue;
    if (birthDate) {
      try {
        const dateObj = new Date(birthDate);
        if (!isNaN(dateObj.getTime())) {
          birthDateValue = dateObj.toISOString().split('T')[0];
        } else {
          birthDateValue = '2000-01-01';
        }
      } catch (dateError) {
        birthDateValue = '2000-01-01';
      }
    } else {
      birthDateValue = '2000-01-01';
    }

    // معالجة الجنس
    const genderValue = (gender === 'male' || gender === 'ذكر') ? 'MALE' : 
                       (gender === 'female' || gender === 'أنثى') ? 'FEMALE' : 'MALE';

    const sql = `
      INSERT INTO PATIENTS (
        PATIENT_UID, FIRSTNAME, FATHERNAME, GRANDFATHERNAME, FAMILYNAME, 
        IDNUMBER, BIRTHDATE, GENDER, ADDRESS, PHONE, 
        IQRAR, IDIMAGE, MEDICAL_RECORD_NO, STATUS, CREATEDAT, APPROVED_DATE, APPROVED_BY
      ) VALUES (
        :patientUid, :firstName, :fatherName, :grandfatherName, :familyName,
        :idNumber, TO_DATE(:birthDate, 'YYYY-MM-DD'), :gender, :address, :phone,
        :iqrar, :idImage, :medicalRecordNo, 'active', SYSDATE, SYSDATE, :approvedBy
      )
    `;

    const bindValues = {
      patientUid: patientUid,
      firstName: firstName.trim(),
      fatherName: fatherName?.trim() || '',
      grandfatherName: grandfatherName?.trim() || '',
      familyName: familyName.trim(),
      idNumber: parseInt(idNumber),
      birthDate: birthDateValue,
      gender: genderValue,
      address: address?.trim() || 'غير محدد',
      phone: phone?.replace(/\D/g, '') || '0000000000',
      iqrar: agreementImage || 'https://example.com/default-iqrar.png',
      idImage: idImage || 'https://example.com/default-idimage.png',
      medicalRecordNo: medicalRecordNo,
      approvedBy: 'secretary'
    };

    const result = await connection.execute(sql, bindValues, { autoCommit: true });

    res.status(201).json({ 
      message: "✅ تمت إضافة المريض بنجاح",
      patientUid: patientUid,
      medicalRecordNo: medicalRecordNo,
      rowsAffected: result.rowsAffected
    });

  } catch (err) {
    console.error("❌ Error adding patient:", err);
    
    let errorMessage = "❌ Error adding patient";
    if (err.errorNum === 1) {
      errorMessage = "❌ Patient already exists with this ID number";
    } else if (err.errorNum === 2290) {
      errorMessage = "❌ Data validation error";
    } else if (err.errorNum === 1861) {
      errorMessage = "❌ Invalid date format";
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

// 90. Update patient data
app.put("/patients/:patientId", async (req, res) => {
  const { patientId } = req.params;
  let parsedBody;
  
  if (!req.body) {
    parsedBody = {};
  } else if (typeof req.body === 'string') {
    try {
      parsedBody = JSON.parse(req.body);
    } catch (e) {
      return res.status(400).json({ message: 'Invalid JSON body' });
    }
  } else {
    parsedBody = req.body;
  }

  if (!parsedBody || Object.keys(parsedBody).length === 0) {
    return res.status(400).json({ message: "❌ No data provided for update" });
  }

  let connection;
  try {
    connection = await oracledb.getConnection(dbConfig);

    const allowedFields = [
      'firstName', 'fatherName', 'grandfatherName', 'familyName',
      'birthDate', 'gender', 'address', 'phone', 'idImage', 'iqrar'
    ];

    const setClause = [];
    const bindValues = { patientId };

    allowedFields.forEach(field => {
      if (parsedBody[field] !== undefined && parsedBody[field] !== null) {
        const dbField = field === 'iqrar' ? 'IQRAR' : 
                       field === 'idImage' ? 'IDIMAGE' : 
                       field.toUpperCase();
        
        if (field === 'birthDate') {
          setClause.push(`${dbField} = TO_DATE(:${field}, 'YYYY-MM-DD')`);
          let dateValue = parsedBody[field];
          if (typeof dateValue === 'string' && dateValue.includes('T')) {
            dateValue = dateValue.split('T')[0];
          }
          bindValues[field] = dateValue;
        } else {
          setClause.push(`${dbField} = :${field}`);
          bindValues[field] = parsedBody[field];
        }
      }
    });

    if (setClause.length === 0) {
      return res.status(400).json({ message: "❌ No valid fields to update" });
    }

    const sql = `UPDATE PATIENTS SET ${setClause.join(', ')} WHERE PATIENT_UID = :patientId`;

    const result = await connection.execute(sql, bindValues, { autoCommit: true });

    if (result.rowsAffected === 0) {
      return res.status(404).json({ message: "❌ Patient not found" });
    }

    res.status(200).json({ 
      message: "✅ Patient data updated successfully",
      patientId: patientId,
      updatedFields: setClause
    });

  } catch (err) {
    console.error("❌ Error updating patient:", err);
    res.status(500).json({ 
      message: "❌ Error updating patient", 
      error: err.message 
    });
  } finally {
    if (connection) await connection.close();
  }
});
// Start server
app.listen(PORT, () => {
  console.log(`🚀 Dynamic API Server running on http://localhost:${PORT}`);
  console.log(`📋 Available endpoints:`);
  console.log(`   GET  /all-examinations-full`);
  console.log(`   GET  /all-examinations`);
  console.log(`   GET  /examinations/:patientId`);
  console.log(`   POST /examinations`);
  console.log(`   POST /screening`);
  console.log(`   GET  /students`);
  console.log(`   GET  /patients`);
  console.log(`   GET  /student_assignments/:studentId`);
  console.log(`   POST /student_assignments`);
  console.log(`   PUT  /patients/:patientId/status`);
  console.log(`   PUT  /appointments/update_examined/:patientId`);
  console.log(`   GET  /check-patient/:patientUid`);
  console.log(`   GET  /check-doctor/:id`);
  console.log(`   GET  /patients/by-appointment-id/:idnumber`);
  console.log(`   GET  /patients/:id`);
  console.log(`   GET  /pendingUsers`);
  console.log(`   POST /pendingUsers`);
  console.log(`   POST /approveUser`);
  console.log(`   POST /rejectUser`);
  console.log(`   POST /updateUser`);
  console.log(`   GET  /rejectedUsers`);
  console.log(`   GET  /users`);
  console.log(`   POST /users`);
  console.log(`   GET  /users/:id`);
  console.log(`   PUT  /users/:id`);
  console.log(`   DELETE /users/:id`);
  console.log(`   POST /login`);
  console.log(`   GET  /doctors`);
  console.log(`   GET  /doctors/:id`);
  console.log(`   GET  /doctors/:id/type`);
  console.log(`   PUT  /doctors/:id/type`);
  console.log(`   PUT  /doctors/:id/features`);
  console.log(`   PUT  /doctors/batch/features`);
  console.log(`   PUT  /doctors/batch/features-simple`);
  console.log(`   GET  /appointments`);
  console.log(`   POST /appointments`);
  console.log(`   GET  /appointments/count`);
  console.log(`   GET  /waitingList`);
  console.log(`   POST /waitingList`);
  console.log(`   DELETE /waitingList/:id`);
  console.log(`   GET  /patientExams`);
  console.log(`   POST /patientExams`);
  console.log(`   GET  /patients`);
  console.log(`   GET  /students/:userId`);
  console.log(`   GET  /bookingSettings`);
  console.log(`   PUT  /bookingSettings`);
  console.log(`   POST /add-test-patient`);
  console.log(`   GET  /all-examinations-simple`);
  console.log(`   GET  /examination-full/:examId`);
  console.log(`   POST /add-test-examination`);
});
