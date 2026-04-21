/**
 * validateInput.js - Server-side input validation and sanitization
 */

// States where United Settlement does not operate. Users selecting one of
// these from the form will get the "service not available in your state"
// error. Also filtered out of the dropdown in public/index.html so users
// can't pick them in the first place.
const BLOCKED_STATES = ['CT', 'GA', 'IL', 'KS', 'ME', 'NH', 'NV', 'OR', 'SC', 'VT', 'WV'];

const VALID_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL',
  'IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE',
  'NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD',
  'TN','TX','UT','VT','VA','WA','WV','WI','WY'
];

function stripHtml(str) {
  return str.replace(/<[^>]*>/g, '').trim();
}

module.exports = function validateInput(req, res, next) {
  const data = req.body;
  const errors = [];

  // fname: 2-50 chars, letters/spaces/hyphens/apostrophes
  if (!data.fname || typeof data.fname !== 'string') {
    errors.push('First name is required.');
  } else {
    data.fname = stripHtml(data.fname);
    if (data.fname.length < 2 || data.fname.length > 50) {
      errors.push('First name must be 2-50 characters.');
    } else if (!/^[a-zA-Z\s\-']+$/.test(data.fname)) {
      errors.push('First name contains invalid characters.');
    }
  }

  // lname: 2-50 chars, letters/spaces/hyphens/apostrophes
  if (!data.lname || typeof data.lname !== 'string') {
    errors.push('Last name is required.');
  } else {
    data.lname = stripHtml(data.lname);
    if (data.lname.length < 2 || data.lname.length > 50) {
      errors.push('Last name must be 2-50 characters.');
    } else if (!/^[a-zA-Z\s\-']+$/.test(data.lname)) {
      errors.push('Last name contains invalid characters.');
    }
  }

  // dob: YYYY-MM-DD format from <input type="date">, age 18-99
  if (!data.dob || typeof data.dob !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.dob)) {
    errors.push('Date of birth is required.');
  } else {
    const dobDate = new Date(data.dob);
    if (isNaN(dobDate.getTime())) {
      errors.push('Invalid date of birth.');
    } else {
      const ageYears = (Date.now() - dobDate.getTime()) / (365.25 * 24 * 3600 * 1000);
      if (ageYears < 18) {
        errors.push('You must be 18 or older.');
      } else if (ageYears > 99) {
        errors.push('Invalid date of birth.');
      }
    }
  }

  // phone: exactly 10 digits
  if (!data.phone || typeof data.phone !== 'string') {
    errors.push('Phone number is required.');
  } else {
    data.phone = data.phone.replace(/\D/g, '');
    if (data.phone.length !== 10) {
      errors.push('Phone number must be 10 digits.');
    }
  }

  // email: valid format
  if (!data.email || typeof data.email !== 'string') {
    errors.push('Email is required.');
  } else {
    data.email = stripHtml(data.email).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
      errors.push('Invalid email address.');
    }
  }

  // calltime: valid option or "pick:YYYY-MM-DD HH:MM"
  if (data.calltime && typeof data.calltime === 'string' && data.calltime.startsWith('pick:')) {
    // Validate the picked time is between 9am-9pm Eastern (call center hours)
    var timePart = data.calltime.split(' ')[1] || '';
    var hour = parseInt(timePart.split(':')[0], 10);
    if (isNaN(hour) || hour < 9 || hour >= 21) {
      errors.push('Please pick a time between 9:00 AM and 9:00 PM Eastern.');
    }
  } else if (!data.calltime || !['now', '1hour', '2hours', 'tomorrow', 'morning', 'afternoon', 'evening', 'asap'].includes(data.calltime)) {
    data.calltime = 'now';
  }

  // state: valid 2-letter code, not blocked
  if (!data.state || typeof data.state !== 'string') {
    errors.push('State is required.');
  } else {
    data.state = data.state.toUpperCase();
    if (!VALID_STATES.includes(data.state)) {
      errors.push('Invalid state.');
    } else if (BLOCKED_STATES.includes(data.state)) {
      errors.push('Sorry, debt relief services are not available in your state at this time.');
    }
  }

  // lamount: integer 1-100
  if (data.lamount !== undefined) {
    data.lamount = parseInt(data.lamount, 10);
    if (isNaN(data.lamount) || data.lamount < 1 || data.lamount > 100) {
      data.lamount = 15; // Default
    }
  } else {
    data.lamount = 15;
  }

  // pripolicy: must be true
  if (!data.pripolicy) {
    errors.push('You must agree to the privacy policy.');
  }

  if (errors.length > 0) {
    return res.status(400).json({
      success: false,
      message: errors[0] // Return first error
    });
  }

  next();
};
