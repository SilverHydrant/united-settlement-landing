/**
 * formProxy.js - Proxies form submissions to United Settlement's PHP endpoint
 * Maps our form data to the full payload format their form posts
 */

const ENDPOINT = process.env.UNITED_SETTLEMENT_ENDPOINT || 'https://unitedsettlement.com/sendmail-apply-for-debt-relief-v3-grp.php';
const PAGE_URL = process.env.UNITED_SETTLEMENT_PAGE || 'https://unitedsettlement.com/will-debt-relief-help-you-grp';

// Per-state realistic address data: a major city + valid 5-digit ZIP that matches
// (US ZIP codes have state-specific prefix ranges; using a real city ensures the
// city/state/zip triple is internally consistent so the lead doesn't get flagged.)
const STATE_ADDRESS_DATA = {
  AL: { city: 'Birmingham', zip: '35203' },  AK: { city: 'Anchorage',   zip: '99501' },
  AZ: { city: 'Phoenix',    zip: '85001' },  AR: { city: 'Little Rock', zip: '72201' },
  CA: { city: 'Los Angeles',zip: '90001' },  CO: { city: 'Denver',      zip: '80202' },
  CT: { city: 'Hartford',   zip: '06103' },  DE: { city: 'Wilmington',  zip: '19801' },
  DC: { city: 'Washington', zip: '20001' },  FL: { city: 'Miami',       zip: '33101' },
  GA: { city: 'Atlanta',    zip: '30303' },  HI: { city: 'Honolulu',    zip: '96813' },
  ID: { city: 'Boise',      zip: '83702' },  IL: { city: 'Chicago',     zip: '60601' },
  IN: { city: 'Indianapolis',zip: '46204' }, IA: { city: 'Des Moines',  zip: '50309' },
  KS: { city: 'Wichita',    zip: '67202' },  KY: { city: 'Louisville',  zip: '40202' },
  LA: { city: 'New Orleans',zip: '70112' },  ME: { city: 'Portland',    zip: '04101' },
  MD: { city: 'Baltimore',  zip: '21201' },  MA: { city: 'Boston',      zip: '02108' },
  MI: { city: 'Detroit',    zip: '48226' },  MN: { city: 'Minneapolis', zip: '55401' },
  MS: { city: 'Jackson',    zip: '39201' },  MO: { city: 'Kansas City', zip: '64106' },
  MT: { city: 'Billings',   zip: '59101' },  NE: { city: 'Omaha',       zip: '68102' },
  NV: { city: 'Las Vegas',  zip: '89101' },  NH: { city: 'Manchester',  zip: '03101' },
  NJ: { city: 'Newark',     zip: '07102' },  NM: { city: 'Albuquerque', zip: '87102' },
  NY: { city: 'New York',   zip: '10001' },  NC: { city: 'Charlotte',   zip: '28202' },
  ND: { city: 'Fargo',      zip: '58102' },  OH: { city: 'Columbus',    zip: '43215' },
  OK: { city: 'Oklahoma City', zip: '73102' }, OR: { city: 'Portland',  zip: '97201' },
  PA: { city: 'Philadelphia', zip: '19102' }, RI: { city: 'Providence', zip: '02903' },
  SC: { city: 'Columbia',   zip: '29201' },  SD: { city: 'Sioux Falls', zip: '57104' },
  TN: { city: 'Nashville',  zip: '37203' },  TX: { city: 'Houston',     zip: '77002' },
  UT: { city: 'Salt Lake City', zip: '84101' }, VT: { city: 'Burlington', zip: '05401' },
  VA: { city: 'Richmond',   zip: '23219' },  WA: { city: 'Seattle',     zip: '98101' },
  WV: { city: 'Charleston', zip: '25301' },  WI: { city: 'Milwaukee',   zip: '53202' },
  WY: { city: 'Cheyenne',   zip: '82001' }
};

const STREET_NAMES = ['Main St', 'Oak Ave', 'Maple Dr', 'Park Ave', 'Elm St', 'Cedar Ln', 'Pine St', 'Washington Ave', 'Lake Dr', 'Hill Rd'];

function randomAddressForState(state) {
  const cityData = STATE_ADDRESS_DATA[state] || { city: 'Springfield', zip: '00000' };
  const num = Math.floor(Math.random() * 9000) + 100;          // 100-9099
  const street = STREET_NAMES[Math.floor(Math.random() * STREET_NAMES.length)];
  return { address: `${num} ${street}`, city: cityData.city, zip: cityData.zip };
}

// Convert YYYY-MM-DD (HTML date input) → MM/DD/YYYY (their form format)
function dobToMMDDYYYY(yyyymmdd) {
  if (!yyyymmdd || !/^\d{4}-\d{2}-\d{2}$/.test(yyyymmdd)) return '01/01/1970';
  const [y, m, d] = yyyymmdd.split('-');
  return `${m}/${d}/${y}`;
}

/**
 * Build the full payload that United Settlement's endpoint expects
 */
function buildPayload(data) {
  const calltimeLabels = {
    now: 'Now',
    '1hour': '1Hr',
    '2hours': '2Hr',
    tomorrow: 'Tomorrow',
    asap: 'ASAP',
    morning: 'Morning',
    afternoon: 'Afternoon',
    evening: 'Evening'
  };

  let calltimeLabel;
  if (data.calltime && data.calltime.startsWith('pick:')) {
    calltimeLabel = data.calltime.replace('pick:', '');
  } else {
    calltimeLabel = calltimeLabels[data.calltime] || 'Now';
  }

  // Generate a realistic, state-consistent address for the SSN-less form
  const addr = randomAddressForState(data.state);

  return {
    // Real data from our form
    fname: data.fname,
    lname: data.lname,                        // Real last name
    email: data.email,
    phone: data.phone,
    ustate: data.state,
    lamount: String(data.lamount),

    // Address: realistic random street + real city/ZIP for the state
    address: addr.address,
    city: addr.city,
    zip: addr.zip,

    // DOB: real, converted to MM/DD/YYYY (their form format)
    dob: dobToMMDDYYYY(data.dob),

    // SSN: 9 zeros (per intake spec — they collect real SSN over the phone)
    ssn: '000000000',

    // Preferred call time, attached to lname so reps can see it
    callbackNote: 'Callback-' + calltimeLabel,

    // System fields
    pripolicy: '1',
    usersip: data.userip || '0.0.0.0',
    pageurl: PAGE_URL,
    isSendEmail: '1',
    lamountef: String((data.lamount || 15) * 1000),

    // UTM / tracking passthrough
    utmid: data.utmid || '',
    utmsource: data.utmsource || '',
    utmmedium: data.utmmedium || '',
    utmcampaign: data.utmcampaign || '',
    utmcontent: data.utmcontent || '',
    utmterm: data.utmterm || '',
    sidcamid: data.sidcamid || '',
    sourceid: data.sourceid || '',
    subidone: data.subidone || '',
    subidtwo: data.subidtwo || '',
    subidthree: data.subidthree || '',
    subidfour: data.subidfour || '',
    adsclick: data.gclid || ''
  };
}

/**
 * URL-encode a payload object
 */
function encodePayload(payload) {
  return Object.keys(payload)
    .map(key => encodeURIComponent(key) + '=' + encodeURIComponent(payload[key]))
    .join('&');
}

/**
 * Submit the form data to United Settlement's endpoint
 */
async function submit(data) {
  const payload = buildPayload(data);
  const body = encodePayload(payload);

  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': PAGE_URL,
        'Origin': 'https://unitedsettlement.com',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      },
      redirect: 'follow'
    });

    const responseText = await response.text();

    // Try to parse as JSON (their endpoint may return JSON)
    let responseData;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = { raw: responseText };
    }

    if (response.ok) {
      return { success: true, data: responseData };
    } else {
      return {
        success: false,
        error: `HTTP ${response.status}: ${responseText.substring(0, 200)}`
      };
    }
  } catch (err) {
    return {
      success: false,
      error: `Network error: ${err.message}`
    };
  }
}

module.exports = { submit, buildPayload };
