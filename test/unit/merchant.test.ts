import { describe, expect, it } from 'vitest';
import { normalizeMerchant } from '../../src/client/merchant';

// Shapes seen in HDFC and ICICI statements; names, handles and numbers are invented.
describe('normalizeMerchant', () => {
  it.each([
    ['UPI-SWIGGY-SWIGGY8@YBL-412398712', 'Swiggy'],
    ['UPI-SWIGGY-SWIGGY8@YBL-412398712 -PAYMENT FROM PHONE', 'Swiggy'],
    ['POS 416021XXXXXX1234 BLINKIT', 'Blinkit'],
    ['NEFT CR-ACME CORP SALARY APR', 'Acme Corp Salary'],
    ['UPI/ZOMATO/123', 'Zomato'],
    ['UPI/412398712/ZOMATO/zomato@hdfcbank/Payment', 'Zomato'],
    ['UPI-RAHUL KUMAR-rahul.k@okaxis-HDFC0001234-412398712-DINNER', 'Rahul Kumar'],
    ['ACH D- TEST INSURANCE LTD', 'Test Insurance'],
    ['AMAZON PAY INDIA PRIVATE LIMITED', 'Amazon Pay'],
    ['UBER INDIA SYSTEMS (Sr:22221)', 'Uber India Systems'],
    ['UPI/CAFÉ COFFEE DAY/77', 'Café Coffee Day'],
    ['IMPS-412398712-TEST FRIEND-HDFC-XXXXXXXX1234-RENT', 'Test Friend'],
    ['ATM WDL NWD 12345 MG ROAD', 'Wdl Mg Road'],
    ['PAYMENT RECEIVED THANK YOU', ''],
    ['412398712', ''],
    ['KFC', 'KFC'],
  ])('%s → %s', (description, merchant) => expect(normalizeMerchant(description)).toBe(merchant));
});
