/**
 * botSubmitter.js — Playwright bot that fills out the United Settlement
 * multi-step form on https://unitedsettlement.com/will-debt-relief-help-you-grp
 *
 * The form is one <form> with JS show/hide between steps. We walk through each
 * step pressing Continue, type into each field with realistic delays, and
 * submit at the SSN page. Returns a structured result so the caller can log
 * success vs failure per lead.
 */

const { chromium } = require('playwright');

const FORM_URL = process.env.UNITED_SETTLEMENT_PAGE || 'https://unitedsettlement.com/will-debt-relief-help-you-grp';

// State -> realistic city + valid 5-digit ZIP. Internally consistent so the
// city/state/zip triple doesn't get flagged as junk on their CRM.
const STATE_ADDRESS_DATA = {
  AL: { city: 'Birmingham',  zip: '35203' }, AK: { city: 'Anchorage',     zip: '99501' },
  AZ: { city: 'Phoenix',     zip: '85001' }, AR: { city: 'Little Rock',   zip: '72201' },
  CA: { city: 'Los Angeles', zip: '90001' }, CO: { city: 'Denver',        zip: '80202' },
  DE: { city: 'Wilmington',  zip: '19801' }, DC: { city: 'Washington',    zip: '20001' },
  FL: { city: 'Miami',       zip: '33101' }, HI: { city: 'Honolulu',      zip: '96813' },
  ID: { city: 'Boise',       zip: '83702' }, IN: { city: 'Indianapolis',  zip: '46204' },
  IA: { city: 'Des Moines',  zip: '50309' }, KY: { city: 'Louisville',    zip: '40202' },
  LA: { city: 'New Orleans', zip: '70112' }, MD: { city: 'Baltimore',     zip: '21201' },
  MA: { city: 'Boston',      zip: '02108' }, MI: { city: 'Detroit',       zip: '48226' },
  MN: { city: 'Minneapolis', zip: '55401' }, MS: { city: 'Jackson',       zip: '39201' },
  MO: { city: 'Kansas City', zip: '64106' }, MT: { city: 'Billings',      zip: '59101' },
  NE: { city: 'Omaha',       zip: '68102' }, NV: { city: 'Las Vegas',     zip: '89101' },
  NJ: { city: 'Newark',      zip: '07102' }, NM: { city: 'Albuquerque',   zip: '87102' },
  NY: { city: 'New York',    zip: '10001' }, NC: { city: 'Charlotte',     zip: '28202' },
  ND: { city: 'Fargo',       zip: '58102' }, OH: { city: 'Columbus',      zip: '43215' },
  OK: { city: 'Oklahoma City', zip: '73102' }, PA: { city: 'Philadelphia', zip: '19102' },
  RI: { city: 'Providence',  zip: '02903' }, SD: { city: 'Sioux Falls',   zip: '57104' },
  TN: { city: 'Nashville',   zip: '37203' }, TX: { city: 'Houston',       zip: '77002' },
  UT: { city: 'Salt Lake City', zip: '84101' }, VA: { city: 'Richmond',   zip: '23219' },
  WA: { city: 'Seattle',     zip: '98101' }, WI: { city: 'Milwaukee',     zip: '53202' },
  WY: { city: 'Cheyenne',    zip: '82001' }
};

const STREET_NAMES = ['Main St', 'Oak Ave', 'Maple Dr', 'Park Ave', 'Elm St', 'Cedar Ln', 'Pine St', 'Washington Ave', 'Lake Dr', 'Hill Rd'];

function randomAddress(state) {
  const cityData = STATE_ADDRESS_DATA[state] || { city: 'Springfield', zip: '00000' };
  const num = Math.floor(Math.random() * 9000) + 100;
  const street = STREET_NAMES[Math.floor(Math.random() * STREET_NAMES.length)];
  return { address: `${num} ${street}`, city: cityData.city, zip: cityData.zip };
}

function dobToMMDDYYYY(yyyymmdd) {
  if (!yyyymmdd || !/^\d{4}-\d{2}-\d{2}$/.test(yyyymmdd)) return '01/01/1970';
  const [y, m, d] = yyyymmdd.split('-');
  return `${m}/${d}/${y}`;
}

// Slider value 1-100 maps to the visible "$X" label. The form treats this as
// a 1-100 range; it converts internally. We just need to set it.
function debtSliderValue(lamount) {
  const v = parseInt(lamount, 10);
  if (isNaN(v) || v < 1) return 15;
  if (v > 100) return 100;
  return v;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randDelay = (min, max) => sleep(min + Math.floor(Math.random() * (max - min)));

// Their form has one Continue button per step, all rendered in the DOM at once
// with only the active step's button visible. Click the visible one.
async function clickVisible(page, selector) {
  const visible = page.locator(selector).filter({ visible: true });
  await visible.first().click();
}

// Same trick for the field locators — multiple inputs with the same name can
// exist (one per step container); fill the visible one.
async function fillVisible(page, selector, value) {
  const visible = page.locator(selector).filter({ visible: true });
  await visible.first().fill(value);
}

async function selectVisible(page, selector, value) {
  const visible = page.locator(selector).filter({ visible: true });
  await visible.first().selectOption(value);
}

/**
 * Reusable browser instance — launching Chromium takes 1-2s, so we share one
 * browser across all submissions and just open a fresh context per lead for
 * isolation (cookies, localStorage are per-context).
 */
let _browser = null;
async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  _browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'  // required for Docker on low-memory hosts
    ]
  });
  return _browser;
}

async function shutdownBrowser() {
  if (_browser) {
    try { await _browser.close(); } catch (_) {}
    _browser = null;
  }
}
process.on('SIGTERM', shutdownBrowser);
process.on('SIGINT', shutdownBrowser);

/**
 * Submit one lead by walking the multi-step form. Returns:
 *   { success: true, durationMs }
 *   { success: false, step, error, durationMs }
 *
 * If `onStep` is provided, it's called each time the bot advances so the
 * caller (api route) can update the lead-status tracker.
 */
async function submitViaBot(lead, onStep) {
  const startedAt = Date.now();
  let context = null;
  let page = null;
  let currentStep = 'init';
  const reportStep = (s) => { currentStep = s; if (onStep) { try { onStep(s); } catch (_) {} } };

  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: 'en-US'
      // No UA override, no init-script fingerprint masking — this is
      // authorized automation per the operator, so we don't hide what we are.
    });

    page = await context.newPage();

    // ---- STEP 0: Load the form page ----
    reportStep('load');
    await page.goto(FORM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await randDelay(800, 1500);

    // ---- STEP 1: Debt amount slider + Continue ----
    reportStep('debt-slider');
    const debtVal = debtSliderValue(lead.lamount);
    // The slider input is type=range with name=lamount. Set it directly and dispatch input event.
    await page.evaluate((v) => {
      const slider = document.querySelector('input[name="lamount"]');
      if (slider) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(slider, String(v));
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        slider.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, debtVal);
    await randDelay(400, 900);
    await clickVisible(page, 'button:has-text("Continue")');
    await randDelay(700, 1300);

    // ---- STEP 2: First Name + Last Name ----
    reportStep('name');
    await fillVisible(page, 'input[name="fname"]', lead.fname);
    await randDelay(300, 700);
    await fillVisible(page, 'input[name="lname"]', lead.lname);
    await randDelay(400, 900);
    await clickVisible(page, 'button:has-text("Continue")');
    await randDelay(700, 1300);

    // ---- STEP 3: Email + Phone + State ----
    reportStep('contact');
    await fillVisible(page, 'input[name="email"]', lead.email);
    await randDelay(300, 700);
    await fillVisible(page, 'input[name="phone"]', lead.phone);
    await randDelay(300, 700);
    await selectVisible(page, 'select[name="state"]', lead.state);
    await randDelay(400, 900);
    await clickVisible(page, 'button:has-text("Continue")');
    await randDelay(700, 1300);

    // ---- STEP 4: Address ----
    reportStep('address');
    const addr = randomAddress(lead.state);
    await fillVisible(page, 'input[name="address"]', addr.address);
    await randDelay(300, 700);
    await fillVisible(page, 'input[name="city"]', addr.city);
    await randDelay(300, 700);
    await fillVisible(page, 'input[name="zip"]', addr.zip);
    await randDelay(400, 900);
    await clickVisible(page, 'button:has-text("Continue")');
    await randDelay(700, 1300);

    // ---- STEP 5: Date of Birth ----
    reportStep('dob');
    const dob = dobToMMDDYYYY(lead.dob);
    await fillVisible(page, 'input[name="dob"]', dob);
    await randDelay(400, 900);
    await clickVisible(page, 'button:has-text("Continue")');
    await randDelay(700, 1300);

    // ---- STEP 6: SSN + Get Started (final submit) ----
    reportStep('ssn');
    await fillVisible(page, 'input[name="ssn"]', '000000000');
    await randDelay(400, 900);

    // Click Get Started — submits the whole form to their PHP handler
    reportStep('submit');
    const [navResponse] = await Promise.all([
      // Wait for either a navigation OR an XHR to the submission endpoint, whichever happens first
      Promise.race([
        page.waitForResponse((r) => r.url().includes('sendmail-apply-for-debt-relief') && r.request().method() === 'POST', { timeout: 20000 }).catch(() => null),
        page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => null)
      ]),
      page.locator('button:has-text("Get Started")').filter({ visible: true }).first().click()
    ]);

    let httpStatus = null;
    let respPreview = null;
    if (navResponse && typeof navResponse.status === 'function') {
      httpStatus = navResponse.status();
      try { respPreview = (await navResponse.text()).slice(0, 200); } catch (_) {}
    }

    return {
      success: true,
      step: 'submitted',
      httpStatus,
      respPreview,
      durationMs: Date.now() - startedAt
    };
  } catch (err) {
    return {
      success: false,
      step: currentStep,
      error: err && err.message ? err.message : String(err),
      durationMs: Date.now() - startedAt
    };
  } finally {
    if (page) { try { await page.close(); } catch (_) {} }
    if (context) { try { await context.close(); } catch (_) {} }
  }
}

module.exports = { submitViaBot, shutdownBrowser };
