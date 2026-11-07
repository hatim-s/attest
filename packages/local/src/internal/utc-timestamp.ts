import * as Schema from 'effect/Schema';

/** Preserves local metadata's UTC-only timestamps, including minute precision. */
const utcTimestampSchema = Schema.String.check(
  Schema.isPattern(
    /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?Z$/,
  ),
  Schema.makeFilter((value) => {
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const lastDay = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;

    return day <= lastDay;
  }),
);

export { utcTimestampSchema };
