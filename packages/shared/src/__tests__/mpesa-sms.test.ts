import { describe, expect, it } from "vitest";

import type { MpesaSmsParseResult, ParsedMpesaSms } from "../mpesa-sms.js";
import { parseMpesaSms } from "../mpesa-sms.js";

/*
 * SYNTHETIC FIXTURES. Every message below is written from Safaricom's
 * published confirmation wording; the codes, names, numbers and balances are
 * invented. Real redacted SMS for each format replace or join these once
 * Dennis supplies them (Phase 2 handoff, "Sample data").
 */

interface Fixture {
  name: string;
  text: string;
  expected: ParsedMpesaSms;
}

const SYNTHETIC_BUY_GOODS: Fixture[] = [
  {
    name: "a supermarket till",
    text: "SKL3ABCDEF Confirmed. Ksh1,500.00 paid to NAIVAS SUPERMARKET. on 12/5/25 at 2:15 PM.New M-PESA balance is Ksh3,250.40. Transaction cost, Ksh0.00. Amount you can transact within the day is 498,500.00. To move money from bank to M-PESA, dial *334#.",
    expected: {
      kind: "buy_goods",
      code: "SKL3ABCDEF",
      amountKesCents: "150000",
      counterparty: "NAIVAS SUPERMARKET",
      occurredAt: "2025-05-12T14:15:00+03:00",
      balanceKesCents: "325040",
      transactionCostKesCents: "0",
    },
  },
  {
    name: "a café till with an app promo",
    text: "TB71XY9Z2Q Confirmed. Ksh250.00 paid to JAVA HOUSE ABC PLACE. on 3/1/25 at 8:07 AM.New M-PESA balance is Ksh12,045.60. Transaction cost, Ksh0.00. Amount you can transact within the day is 499,750.00. Save frequent Tills for quick payment on M-PESA app https://bit.ly/mpesalnk",
    expected: {
      kind: "buy_goods",
      code: "TB71XY9Z2Q",
      amountKesCents: "25000",
      counterparty: "JAVA HOUSE ABC PLACE",
      occurredAt: "2025-01-03T08:07:00+03:00",
      balanceKesCents: "1204560",
      transactionCostKesCents: "0",
    },
  },
  {
    name: "a fuel station, with a space after Ksh",
    text: "SJ48KLMN0P Confirmed. Ksh 4,320.50 paid to TOTALENERGIES WAIYAKI WAY. on 28/2/24 at 6:45 PM. New M-PESA balance is Ksh 15,679.50. Transaction cost, Ksh 0.00.",
    expected: {
      kind: "buy_goods",
      code: "SJ48KLMN0P",
      amountKesCents: "432050",
      counterparty: "TOTALENERGIES WAIYAKI WAY",
      occurredAt: "2024-02-28T18:45:00+03:00",
      balanceKesCents: "1567950",
      transactionCostKesCents: "0",
    },
  },
  {
    name: "a kiosk, with a lowercase 'confirmed'",
    text: "UA2C3D4E5F confirmed. Ksh85.00 paid to MAMA MBOGA KIOSK. on 9/10/26 at 11:30 AM.New M-PESA balance is Ksh915.00. Transaction cost, Ksh0.00.",
    expected: {
      kind: "buy_goods",
      code: "UA2C3D4E5F",
      amountKesCents: "8500",
      counterparty: "MAMA MBOGA KIOSK",
      occurredAt: "2026-10-09T11:30:00+03:00",
      balanceKesCents: "91500",
      transactionCostKesCents: "0",
    },
  },
  {
    name: "a business name with dots in it",
    text: "SG5HJK6LMN Confirmed. Ksh12,999.00 paid to J.K. HARDWARE & SONS LTD. on 15/11/24 at 5:02 PM.New M-PESA balance is Ksh1.00. Transaction cost, Ksh0.00. Amount you can transact within the day is 487,001.00.",
    expected: {
      kind: "buy_goods",
      code: "SG5HJK6LMN",
      amountKesCents: "1299900",
      counterparty: "J.K. HARDWARE & SONS LTD",
      occurredAt: "2024-11-15T17:02:00+03:00",
      balanceKesCents: "100",
      transactionCostKesCents: "0",
    },
  },
];

const SYNTHETIC_SEND_MONEY: Fixture[] = [
  {
    name: "a full 07 number",
    text: "SKM4BCDEFG Confirmed. Ksh500.00 sent to JANE WANJIKU 0712345678 on 12/5/25 at 9:05 AM. New M-PESA balance is Ksh2,000.00. Transaction cost, Ksh7.00. Amount you can transact within the day is 499,500.00. Earn interest daily on Ziidi MMF,Dial *334#",
    expected: {
      kind: "send_money",
      code: "SKM4BCDEFG",
      amountKesCents: "50000",
      counterparty: "JANE WANJIKU",
      phone: "+254712345678",
      occurredAt: "2025-05-12T09:05:00+03:00",
      balanceKesCents: "200000",
      transactionCostKesCents: "700",
    },
  },
  {
    name: "a number Safaricom masked",
    text: "TC9DEF1GHJ Confirmed. Ksh2,300.00 sent to PETER OTIENO 0722***456 on 14/3/25 at 4:40 PM. New M-PESA balance is Ksh7,700.00. Transaction cost, Ksh34.00. Amount you can transact within the day is 497,700.00.",
    expected: {
      kind: "send_money",
      code: "TC9DEF1GHJ",
      amountKesCents: "230000",
      counterparty: "PETER OTIENO",
      phoneMasked: "0722***456",
      occurredAt: "2025-03-14T16:40:00+03:00",
      balanceKesCents: "770000",
      transactionCostKesCents: "3400",
    },
  },
  {
    name: "a number in 254 form",
    text: "SH21QRSTUV Confirmed. Ksh12,750.00 sent to MARY AKINYI ODHIAMBO 254798765432 on 7/8/24 at 10:12 PM. New M-PESA balance is Ksh250.00. Transaction cost, Ksh105.00.",
    expected: {
      kind: "send_money",
      code: "SH21QRSTUV",
      amountKesCents: "1275000",
      counterparty: "MARY AKINYI ODHIAMBO",
      phone: "+254798765432",
      occurredAt: "2024-08-07T22:12:00+03:00",
      balanceKesCents: "25000",
      transactionCostKesCents: "10500",
    },
  },
  {
    name: "a full 01 number",
    text: "UB5FGH2JKL Confirmed. Ksh70.00 sent to SAMUEL KIPROTICH 0110123456 on 1/6/26 at 7:03 AM. New M-PESA balance is Ksh430.00. Transaction cost, Ksh0.00.",
    expected: {
      kind: "send_money",
      code: "UB5FGH2JKL",
      amountKesCents: "7000",
      counterparty: "SAMUEL KIPROTICH",
      phone: "+254110123456",
      occurredAt: "2026-06-01T07:03:00+03:00",
      balanceKesCents: "43000",
      transactionCostKesCents: "0",
    },
  },
  {
    name: "Pochi la Biashara, which shows no number",
    text: "TD3GHJ4KLM Confirmed. Ksh350.00 sent to GRACE NJERI on 20/4/25 at 1:25 PM. New M-PESA balance is Ksh1,650.00. Transaction cost, Ksh0.00.",
    expected: {
      kind: "send_money",
      code: "TD3GHJ4KLM",
      amountKesCents: "35000",
      counterparty: "GRACE NJERI",
      occurredAt: "2025-04-20T13:25:00+03:00",
      balanceKesCents: "165000",
      transactionCostKesCents: "0",
    },
  },
];

const SYNTHETIC_PAYBILL: Fixture[] = [
  {
    name: "prepaid electricity",
    text: "SKN5CDEFGH Confirmed. Ksh2,450.00 sent to KPLC PREPAID for account 37123456789 on 12/5/25 at 7:30 PM New M-PESA balance is Ksh1,050.00. Transaction cost, Ksh34.00.Amount you can transact within the day is 497,550.00. Pay with M-PESA GlobalPay virtual Visa card linked to M-PESA wallet. Dial *334#",
    expected: {
      kind: "paybill",
      code: "SKN5CDEFGH",
      amountKesCents: "245000",
      counterparty: "KPLC PREPAID",
      accountReference: "37123456789",
      occurredAt: "2025-05-12T19:30:00+03:00",
      balanceKesCents: "105000",
      transactionCostKesCents: "3400",
    },
  },
  {
    name: "home internet, with a phone number as the account",
    text: "TE6JKL7MNP Confirmed. Ksh3,999.00 sent to SAFARICOM HOME FIBRE for account 254711000111 on 2/9/25 at 10:00 AM New M-PESA balance is Ksh6,001.00. Transaction cost, Ksh53.00.",
    expected: {
      kind: "paybill",
      code: "TE6JKL7MNP",
      amountKesCents: "399900",
      counterparty: "SAFARICOM HOME FIBRE",
      accountReference: "254711000111",
      occurredAt: "2025-09-02T10:00:00+03:00",
      balanceKesCents: "600100",
      transactionCostKesCents: "5300",
    },
  },
  {
    name: "a bank paybill",
    text: "SF7MNP8QRS Confirmed. Ksh15,000.00 sent to EQUITY BANK LIMITED for account 0123456789012 on 25/6/24 at 3:16 PM New M-PESA balance is Ksh44,500.75. Transaction cost, Ksh108.00.",
    expected: {
      kind: "paybill",
      code: "SF7MNP8QRS",
      amountKesCents: "1500000",
      counterparty: "EQUITY BANK LIMITED",
      accountReference: "0123456789012",
      occurredAt: "2024-06-25T15:16:00+03:00",
      balanceKesCents: "4450075",
      transactionCostKesCents: "10800",
    },
  },
  {
    name: "a water bill with a structured reference",
    text: "UC8PQR9STU Confirmed. Ksh1,250.00 sent to NAIROBI CITY WATER for account ACC-2024/0071 on 30/1/26 at 12:45 PM New M-PESA balance is Ksh8,750.00. Transaction cost, Ksh23.00.",
    expected: {
      kind: "paybill",
      code: "UC8PQR9STU",
      amountKesCents: "125000",
      counterparty: "NAIROBI CITY WATER",
      accountReference: "ACC-2024/0071",
      occurredAt: "2026-01-30T12:45:00+03:00",
      balanceKesCents: "875000",
      transactionCostKesCents: "2300",
    },
  },
  {
    name: "school fees with spaces in the account",
    text: "SE9RST1UVW Confirmed. Ksh60,000.00 sent to STRATHMORE SCHOOL FEES for account ADM 4471 TERM 3 on 5/9/24 at 9:41 AM New M-PESA balance is Ksh3,215.20. Transaction cost, Ksh108.00.",
    expected: {
      kind: "paybill",
      code: "SE9RST1UVW",
      amountKesCents: "6000000",
      counterparty: "STRATHMORE SCHOOL FEES",
      accountReference: "ADM 4471 TERM 3",
      occurredAt: "2024-09-05T09:41:00+03:00",
      balanceKesCents: "321520",
      transactionCostKesCents: "10800",
    },
  },
];

const ALL_FIXTURES = [
  ...SYNTHETIC_BUY_GOODS,
  ...SYNTHETIC_SEND_MONEY,
  ...SYNTHETIC_PAYBILL,
];

const SUPERMARKET = fixtureNamed(SYNTHETIC_BUY_GOODS, "a supermarket till");
const TO_JANE = fixtureNamed(SYNTHETIC_SEND_MONEY, "a full 07 number");

function fixtureNamed(fixtures: Fixture[], name: string): Fixture {
  const fixture = fixtures.find((candidate) => candidate.name === name);
  if (!fixture) throw new Error(`No fixture named "${name}"`);
  return fixture;
}

function parsed(text: string): ParsedMpesaSms {
  const result = parseMpesaSms(text);
  if (!result.ok) throw new Error(`Expected a parse, got "${result.reason}"`);
  return result.sms;
}

function buyGoods({
  amount = "Ksh1,500.00",
  date = "12/5/25",
  time = "2:15 PM",
} = {}): string {
  return `SKL3ABCDEF Confirmed. ${amount} paid to NAIVAS SUPERMARKET. on ${date} at ${time}.New M-PESA balance is Ksh3,250.40. Transaction cost, Ksh0.00.`;
}

describe("parseMpesaSms", () => {
  describe("Buy Goods (synthetic fixtures)", () => {
    it.each(SYNTHETIC_BUY_GOODS)("parses $name", ({ text, expected }) => {
      // #when
      const result = parseMpesaSms(text);

      // #then
      expect(result).toStrictEqual({ ok: true, sms: expected });
    });
  });

  describe("Send Money (synthetic fixtures)", () => {
    it.each(SYNTHETIC_SEND_MONEY)("parses $name", ({ text, expected }) => {
      // #when
      const result = parseMpesaSms(text);

      // #then
      expect(result).toStrictEqual({ ok: true, sms: expected });
    });

    it("keeps a masked 254 number as shown", () => {
      // #given
      const text =
        "TC9DEF1GHJ Confirmed. Ksh2,300.00 sent to PETER OTIENO 254722***456 on 14/3/25 at 4:40 PM.";

      // #when
      const sms = parsed(text);

      // #then
      expect(sms).toMatchObject({
        kind: "send_money",
        counterparty: "PETER OTIENO",
        phoneMasked: "254722***456",
      });
      expect(sms).not.toHaveProperty("phone");
    });

    it("leaves a number it can't read as part of the name rather than guessing", () => {
      // #given
      const text =
        "TC9DEF1GHJ Confirmed. Ksh2,300.00 sent to PETER OTIENO 07123456789 on 14/3/25 at 4:40 PM.";

      // #when
      const sms = parsed(text);

      // #then
      expect(sms.counterparty).toBe("PETER OTIENO 07123456789");
      expect(sms).not.toHaveProperty("phone");
      expect(sms).not.toHaveProperty("phoneMasked");
    });
  });

  describe("Paybill (synthetic fixtures)", () => {
    it.each(SYNTHETIC_PAYBILL)("parses $name", ({ text, expected }) => {
      // #when
      const result = parseMpesaSms(text);

      // #then
      expect(result).toStrictEqual({ ok: true, sms: expected });
    });

    it("treats 'paid to … for account' as a Paybill", () => {
      // #given
      const text =
        "SKN5CDEFGH Confirmed. Ksh2,450.00 paid to KPLC PREPAID for account 37123456789 on 12/5/25 at 7:30 PM";

      // #when
      const sms = parsed(text);

      // #then
      expect(sms).toMatchObject({
        kind: "paybill",
        counterparty: "KPLC PREPAID",
        accountReference: "37123456789",
      });
    });
  });

  describe("copy-paste variations", () => {
    it("reads a message broken across lines with extra whitespace", () => {
      // #given
      const text =
        "  SKL3ABCDEF\r\nConfirmed.\n\nKsh1,500.00  paid to\nNAIVAS\u00A0  SUPERMARKET.\ton 12/5/25 at 2:15\nPM.New M-PESA balance is\nKsh3,250.40. Transaction cost, Ksh0.00. Amount you can transact within the day is 498,500.00. To move money from bank to M-PESA, dial *334#.\n";

      // #when
      const result = parseMpesaSms(text);

      // #then
      expect(result).toStrictEqual({ ok: true, sms: SUPERMARKET.expected });
    });

    it("ignores zero-width characters left by messaging apps", () => {
      // #given
      const text = `\uFEFF${SUPERMARKET.text.replace("Confirmed", "Con\u200Bfirmed")}`;

      // #when
      const sms = parsed(text);

      // #then
      expect(sms.code).toBe("SKL3ABCDEF");
    });

    it("ignores text before the code", () => {
      // #given
      const text = `From: MPESA\nToday 2:16 PM\n${SUPERMARKET.text}`;

      // #when
      const result = parseMpesaSms(text);

      // #then
      expect(result).toStrictEqual({ ok: true, sms: SUPERMARKET.expected });
    });

    it("uppercases a lowercase transaction code", () => {
      // #given
      const text = buyGoods().replace("SKL3ABCDEF", "skl3abcdef");

      // #when
      const sms = parsed(text);

      // #then
      expect(sms.code).toBe("SKL3ABCDEF");
    });

    it.each([
      ["Ksh1,500.00", "150000"],
      ["Ksh 1,500.00", "150000"],
      ["Ksh1500.00", "150000"],
      ["KSH1,500.00", "150000"],
      ["Kshs.1,500.00", "150000"],
      ["Ksh1,500", "150000"],
    ])("reads the amount written as %s", (amount, cents) => {
      // #when
      const sms = parsed(buyGoods({ amount }));

      // #then
      expect(sms.amountKesCents).toBe(cents);
    });

    it("leaves out the balance and cost when the SMS stops after the time", () => {
      // #given
      const text =
        "SKL3ABCDEF Confirmed. Ksh1,500.00 paid to NAIVAS SUPERMARKET. on 12/5/25 at 2:15 PM.";

      // #when
      const sms = parsed(text);

      // #then
      expect(sms).not.toHaveProperty("balanceKesCents");
      expect(sms).not.toHaveProperty("transactionCostKesCents");
    });
  });

  describe("several messages pasted together", () => {
    it("parses the first payment confirmation", () => {
      // #given
      const text = `${SUPERMARKET.text}\n\n${TO_JANE.text}`;

      // #when
      const result = parseMpesaSms(text);

      // #then
      expect(result).toStrictEqual({ ok: true, sms: SUPERMARKET.expected });
    });

    it("skips a Fuliza notice pasted before the payment", () => {
      // #given
      const fuliza =
        "SKL3FULIZA Confirmed. Fuliza M-PESA amount is Ksh 150.00. Access Fee charged Ksh 1.50. Total Fuliza M-PESA outstanding amount is Ksh151.50 due on 12/06/25.";
      const text = `${fuliza}\n${TO_JANE.text}`;

      // #when
      const result = parseMpesaSms(text);

      // #then
      expect(result).toStrictEqual({ ok: true, sms: TO_JANE.expected });
    });

    it("skips a received-money SMS pasted before the payment", () => {
      // #given
      const received =
        "SKK2ABCDEF Confirmed.You have received Ksh1,000.00 from JOHN KAMAU 0712345678 on 12/5/25 at 3:00 PM New M-PESA balance is Ksh4,000.00.";
      const text = `${received} ${SUPERMARKET.text}`;

      // #when
      const sms = parsed(text);

      // #then
      expect(sms.code).toBe("SKL3ABCDEF");
    });

    it("doesn't take the balance from the next message", () => {
      // #given
      const text = `SKL3ABCDEF Confirmed. Ksh1,500.00 paid to NAIVAS SUPERMARKET. on 12/5/25 at 2:15 PM. ${TO_JANE.text}`;

      // #when
      const sms = parsed(text);

      // #then
      expect(sms.code).toBe("SKL3ABCDEF");
      expect(sms).not.toHaveProperty("balanceKesCents");
      expect(sms).not.toHaveProperty("transactionCostKesCents");
    });
  });

  describe("times", () => {
    it.each([
      ["12:00 AM", "00:00"],
      ["12:05 AM", "00:05"],
      ["12:59 AM", "00:59"],
      ["1:00 AM", "01:00"],
      ["11:59 AM", "11:59"],
      ["12:00 PM", "12:00"],
      ["12:30 PM", "12:30"],
      ["1:00 PM", "13:00"],
      ["11:59 PM", "23:59"],
      ["2:15pm", "14:15"],
      ["2:15 P.M.", "14:15"],
    ])("reads %s as %s Nairobi time", (time, clock) => {
      // #when
      const sms = parsed(buyGoods({ time }));

      // #then
      expect(sms.occurredAt).toBe(`2025-05-12T${clock}:00+03:00`);
    });

    it("keeps 31/12/25 at 11:59 PM on New Year's Eve", () => {
      // #when
      const sms = parsed(buyGoods({ date: "31/12/25", time: "11:59 PM" }));

      // #then
      expect(sms.occurredAt).toBe("2025-12-31T23:59:00+03:00");
      expect(new Date(sms.occurredAt).toISOString()).toBe(
        "2025-12-31T20:59:00.000Z",
      );
    });

    it("puts 1/1/26 at 12:00 AM in 2026, which is still 2025 in UTC", () => {
      // #when
      const sms = parsed(buyGoods({ date: "1/1/26", time: "12:00 AM" }));

      // #then
      expect(sms.occurredAt).toBe("2026-01-01T00:00:00+03:00");
      expect(new Date(sms.occurredAt).toISOString()).toBe(
        "2025-12-31T21:00:00.000Z",
      );
    });

    it.each([
      ["29/2/24", "2024-02-29"],
      ["01/02/25", "2025-02-01"],
      ["12/5/2025", "2025-05-12"],
    ])("reads the date %s", (date, isoDate) => {
      // #when
      const sms = parsed(buyGoods({ date }));

      // #then
      expect(sms.occurredAt).toBe(`${isoDate}T14:15:00+03:00`);
    });
  });

  describe("amounts", () => {
    it.each([
      ["Ksh1,000,000.00", "100000000"],
      ["Ksh2,345,678.90", "234567890"],
      ["Ksh 12,500,000.05", "1250000005"],
      ["Ksh4.35", "435"],
      ["Ksh1.10", "110"],
      ["Ksh0.29", "29"],
      ["Ksh10.5", "1050"],
      ["Ksh1,234.56", "123456"],
      ["Ksh90,071,992,547,409.93", "9007199254740993"],
    ])("reads %s as %s cents", (amount, cents) => {
      // #when
      const sms = parsed(buyGoods({ amount }));

      // #then
      expect(sms.amountKesCents).toBe(cents);
    });
  });

  describe("messages that aren't payment confirmations", () => {
    it.each(["", "   ", "\n\t \r\n", "\u200B\uFEFF"])(
      "calls %j empty",
      (text) => {
        // #when
        const result = parseMpesaSms(text);

        // #then
        expect(result).toStrictEqual({ ok: false, reason: "empty" });
      },
    );

    it.each([
      [
        "money received",
        "SKL3ABCDEF Confirmed.You have received Ksh1,000.00 from JOHN KAMAU 0712345678 on 12/5/25 at 3:00 PM New M-PESA balance is Ksh4,000.00. Earn interest daily on Ziidi MMF,Dial *334#",
      ],
      [
        "a failed payment",
        "Failed. Insufficient funds in your M-PESA account as well as Fuliza M-PESA to send Ksh5,000.00. Your M-PESA balance is Ksh120.00.",
      ],
      [
        "a Fuliza notice",
        "SKL3ABCDEF Confirmed. Fuliza M-PESA amount is Ksh 150.00. Access Fee charged Ksh 1.50. Total Fuliza M-PESA outstanding amount is Ksh151.50 due on 12/06/25. To check daily charges, Dial *334#OK Select Fuliza M-PESA to Query Charges.",
      ],
      [
        "a cash withdrawal",
        "SKL3ABCDEF Confirmed.on 12/5/25 at 3:00 PMWithdraw Ksh2,000.00 from 123456 - JOHN AGENCIES KAWANGWARE New M-PESA balance is Ksh500.00. Transaction cost, Ksh29.00.",
      ],
      [
        "an airtime purchase",
        "SKL3ABCDEF confirmed.You bought Ksh100.00 of airtime on 12/5/25 at 3:00 PM.New M-PESA balance is Ksh900.00. Transaction cost, Ksh0.00.",
      ],
      [
        "a reversal",
        "SKL3ABCDEF Confirmed. Transaction SKK2ABCDEF has been reversed. Your account balance is now Ksh1,500.00.",
      ],
      [
        "an M-Shwari transfer",
        "SKL3ABCDEF Confirmed.Ksh500.00 transferred to M-Shwari account on 12/5/25 at 3:00 PM. M-PESA balance is Ksh1,000.00 .New M-Shwari saving account balance is Ksh2,500.00.",
      ],
      ["random text", "Lunch with the client at Java, about 1500 bob"],
      [
        "a payment with no code",
        "Confirmed. Ksh1,500.00 paid to NAIVAS SUPERMARKET. on 12/5/25 at 2:15 PM.",
      ],
      ["an 11-character code", buyGoods().replace("SKL3ABCDEF", "SKL3ABCDEFG")],
      ["a 9-character code", buyGoods().replace("SKL3ABCDEF", "SKL3ABCDE")],
      [
        "a code starting with a digit",
        buyGoods().replace("SKL3ABCDEF", "3SKLABCDEF"),
      ],
      ["31 February", buyGoods({ date: "31/2/25" })],
      ["29 February outside a leap year", buyGoods({ date: "29/2/25" })],
      ["month 13", buyGoods({ date: "12/13/25" })],
      ["13 o'clock", buyGoods({ time: "13:15 PM" })],
      ["0 o'clock", buyGoods({ time: "0:15 AM" })],
      ["75 minutes past", buyGoods({ time: "2:75 PM" })],
      ["a 24-hour time", buyGoods({ time: "14:15" })],
      ["a zero amount", buyGoods({ amount: "Ksh0.00" })],
      ["a broken thousands separator", buyGoods({ amount: "Ksh1,50.00" })],
      [
        "a payment cut off before the date",
        "SKL3ABCDEF Confirmed. Ksh1,500.00 paid to NAIVAS SUPERMARKET.",
      ],
      ["no counterparty", buyGoods().replace("NAIVAS SUPERMARKET.", "")],
    ])("rejects %s", (_name, text) => {
      // #when
      const result = parseMpesaSms(text);

      // #then
      expect(result).toStrictEqual({ ok: false, reason: "unrecognised" });
    });
  });

  describe("fuzzing", () => {
    it("never throws on random text", () => {
      // #given
      const random = seededRandom(0x5eed);
      const alphabet = [
        ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
        ...",./:*+- \n\t\u00A0\u200B",
        "Ksh",
        " Confirmed.",
        " paid to ",
        " sent to ",
        " for account ",
        " on ",
        " at ",
        " AM",
        " PM",
        "😀",
      ];

      for (let run = 0; run < 2_000; run += 1) {
        const length = Math.floor(random() * 120);
        const text = Array.from({ length }, () => pick(random, alphabet)).join(
          "",
        );

        // #when
        const result = parseMpesaSms(text);

        // #then
        expectWellFormed(result);
      }
    });

    it("never throws on any prefix or suffix of a fixture", () => {
      for (const { text } of ALL_FIXTURES) {
        for (let cut = 0; cut <= text.length; cut += 1) {
          // #when
          const results = [
            parseMpesaSms(text.slice(0, cut)),
            parseMpesaSms(text.slice(cut)),
          ];

          // #then
          results.forEach(expectWellFormed);
        }
      }
    });

    it("never throws when fixtures are corrupted", () => {
      // #given
      const random = seededRandom(0xc0ffee);
      const noise = [..."0123456789*,./: \nKsAPMxyz"];

      for (const { text } of ALL_FIXTURES) {
        for (let run = 0; run < 300; run += 1) {
          const chars = [...text];
          const edits = 1 + Math.floor(random() * 4);
          for (let edit = 0; edit < edits; edit += 1) {
            const at = Math.floor(random() * chars.length);
            const roll = random();
            if (roll < 0.33) chars.splice(at, 1);
            else if (roll < 0.66) chars.splice(at, 0, pick(random, noise));
            else chars[at] = pick(random, noise);
          }

          // #when
          const result = parseMpesaSms(chars.join(""));

          // #then
          expectWellFormed(result);
        }
      }
    });

    it("handles very long pastes", () => {
      // #given
      const long = [
        "a ".repeat(100_000),
        `SKL3ABCDEF Confirmed. Ksh1.00 paid to ${"A".repeat(100_000)}`,
        `${"SKL3ABCDEF Confirmed. ".repeat(10_000)}`,
        `SKL3ABCDEF Confirmed. Ksh1.00 sent to X ${"*".repeat(100_000)} on 1/1/25 at 1:00 PM`,
        `${"1,".repeat(100_000)}`,
      ];

      for (const text of long) {
        // #when
        const result = parseMpesaSms(text);

        // #then
        expect(result).toStrictEqual({ ok: false, reason: "unrecognised" });
      }
    });

    it("reads back generated messages of every kind", () => {
      // #given
      const random = seededRandom(0xbeef);
      const names = ["NAIVAS", "QUICKMART KILIMANI", "JOHN DOE", "A.B.C LTD"];

      for (let run = 0; run < 500; run += 1) {
        const cents = randomCents(random);
        const day = 1 + Math.floor(random() * 28);
        const month = 1 + Math.floor(random() * 12);
        const year = 20 + Math.floor(random() * 10);
        const hour12 = 1 + Math.floor(random() * 12);
        const minute = Math.floor(random() * 60);
        const isPm = random() < 0.5;
        const code = randomCode(random);
        const name = pick(random, names);
        const when = `on ${day}/${month}/${year} at ${hour12}:${pad(minute)} ${isPm ? "PM" : "AM"}`;
        const amount = `Ksh${formatKsh(cents)}`;
        const kind = pick(random, [
          "buy_goods",
          "send_money",
          "paybill",
        ] as const);
        const text = {
          buy_goods: `${code} Confirmed. ${amount} paid to ${name}. ${when}.New M-PESA balance is Ksh0.00.`,
          send_money: `${code} Confirmed. ${amount} sent to ${name} 0712345678 ${when}. New M-PESA balance is Ksh0.00.`,
          paybill: `${code} Confirmed. ${amount} sent to ${name} for account REF${run} ${when} New M-PESA balance is Ksh0.00.`,
        }[kind];
        const hour = (hour12 % 12) + (isPm ? 12 : 0);

        // #when
        const sms = parsed(text);

        // #then
        expect(sms).toMatchObject({
          kind,
          code,
          amountKesCents: cents.toString(),
          counterparty: name,
          occurredAt: `20${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00+03:00`,
          balanceKesCents: "0",
        });
      }
    });
  });
});

function expectWellFormed(result: MpesaSmsParseResult): void {
  if (!result.ok) {
    expect(["empty", "unrecognised"]).toContain(result.reason);
    return;
  }
  expect(result.sms.code).toMatch(/^[A-Z][A-Z0-9]{9}$/);
  expect(result.sms.amountKesCents).toMatch(/^[1-9]\d*$/);
  expect(result.sms.counterparty.trim()).not.toBe("");
  expect(result.sms.occurredAt).toMatch(
    /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:00\+03:00$/,
  );
  expect(Number.isNaN(Date.parse(result.sms.occurredAt))).toBe(false);
}

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(random: () => number, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error("pick() needs a non-empty list");
  return item;
}

function randomCode(random: () => number): string {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const alphanumerics = `${letters}0123456789`;
  return [
    pick(random, [...letters]),
    ...Array.from({ length: 9 }, () => pick(random, [...alphanumerics])),
  ].join("");
}

function randomCents(random: () => number): bigint {
  const digits = 1 + Math.floor(random() * 14);
  const text = Array.from({ length: digits }, () =>
    Math.floor(random() * 10),
  ).join("");
  return BigInt(text) + 1n;
}

function formatKsh(cents: bigint): string {
  const whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${whole}.${(cents % 100n).toString().padStart(2, "0")}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
