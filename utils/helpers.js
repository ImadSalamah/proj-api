const logger = require('../config/logger');

// 🔥 تنظيف حقل NOTES
const cleanNotesField = (notes) => {
  if (!notes) return '';
  
  try {
    if (typeof notes === 'string') {
      // إزالة أي محتوى غير آمن
      return notes.replace(/[^\w\s\u0600-\u06FF.,!?\-@#$%^&*()_+=]/g, '').substring(0, 1000);
    }
    return String(notes).substring(0, 1000);
  } catch (e) {
    return '';
  }
};

// 🔥 استخراج نص من CLOB
const extractClobText = async (clobData) => {
  if (!clobData) return null;
  
  try {
    if (typeof clobData === 'string') {
      return clobData;
    }
    
    if (typeof clobData === 'object' && clobData !== null) {
      if (clobData.toString && typeof clobData.toString === 'function') {
        return clobData.toString();
      }
    }
    
    return null;
  } catch (error) {
    logger.error('Error extracting CLOB text:', error);
    return null;
  }
};

// 🔥 تحليل JSON المزدوج الترميز
const parseDoubleEncodedJSON = (jsonString) => {
  if (!jsonString || typeof jsonString !== 'string') {
    return {};
  }

  try {
    // تنظيف السلسلة أولاً
    const cleanedString = jsonString.trim();
    
    // إذا كانت سلسلة فارغة
    if (!cleanedString) {
      return {};
    }

    // إذا كانت تبدو ككائن JSON مباشر
    if (cleanedString.startsWith('{') && cleanedString.endsWith('}')) {
      return JSON.parse(cleanedString);
    }

    // إذا كانت تحتوي على JSON مميز
    if (cleanedString.includes('{"') && cleanedString.includes('}')) {
      // حاول إيجاد بداية ونهاية JSON
      const startIndex = cleanedString.indexOf('{');
      const endIndex = cleanedString.lastIndexOf('}') + 1;
      
      if (startIndex !== -1 && endIndex !== -1) {
        const potentialJson = cleanedString.substring(startIndex, endIndex);
        return JSON.parse(potentialJson);
      }
    }

    // إذا فشل كل شيء، أرجع كائن فارغ
    return {};
  } catch (error) {
    logger.warn('JSON parsing failed, returning empty object', {
      input: jsonString.substring(0, 100),
      error: error.message
    });
    return {};
  }
};

// 🔥 التحقق من صحة البريد الإلكتروني
const isValidEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

// 🔥 التحقق من صحة الهاتف
const isValidPhone = (phone) => {
  const phoneRegex = /^[\+]?[0-9\s\-\(\)]{10,}$/;
  return phoneRegex.test(phone);
};

// 🔥 معالجة أخطاء قاعدة البيانات
const handleDatabaseError = (error, res) => {
  logger.error('Database error:', error);

  let message = 'Database error occurred';
  let statusCode = 500;

  switch (error.errorNum) {
    case 1: // unique constraint violated
      message = 'Record already exists';
      statusCode = 409;
      break;
    case 1400: // cannot insert NULL
      message = 'Required fields are missing';
      statusCode = 400;
      break;
    case 2291: // integrity constraint violated - parent key not found
      message = 'Referenced record not found';
      statusCode = 404;
      break;
    case 2290: // check constraint violated
      message = 'Data validation failed';
      statusCode = 400;
      break;
    case 1847: // invalid date format
    case 1861:
      message = 'Invalid date format. Use YYYY-MM-DD';
      statusCode = 400;
      break;
    default:
      message = 'Internal server error';
  }

  return res.status(statusCode).json({
    message,
    errorCode: error.errorNum,
    suggestion: 'Please check your input data'
  });
};

module.exports = {
  cleanNotesField,
  extractClobText,
  parseDoubleEncodedJSON,
  isValidEmail,
  isValidPhone,
  handleDatabaseError
};