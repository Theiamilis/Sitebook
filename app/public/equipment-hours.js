(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.EquipmentHours = api;
})(typeof globalThis === "undefined" ? this : globalThis, function () {
  const HOURS = Object.freeze(["08:00", "09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00"]);
  const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  const MAX_OFF_INTERVALS = 20;

  function toMinutes(value) {
    if (typeof value !== "string" || !TIME_PATTERN.test(value)) return null;
    return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  }

  function formatTime(value) {
    const hour = Math.floor(value / 60);
    const minute = value % 60;
    return String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0");
  }

  function normalizeHours(value) {
    const hours = value instanceof Set ? [...value] : Array.isArray(value) ? value : [];
    return [...new Set(hours.filter((hour) => HOURS.includes(hour)))]
      .sort((left, right) => HOURS.indexOf(left) - HOURS.indexOf(right));
  }

  function normalizeOffIntervals(value) {
    if (!Array.isArray(value)) return { error: "invalid" };
    if (value.length > MAX_OFF_INTERVALS) return { error: "tooMany" };
    const intervals = [];
    for (const entry of value) {
      if (!entry || typeof entry !== "object") return { error: "time" };
      const startTime = String(entry.startTime || "");
      const endTime = String(entry.endTime || "");
      const start = toMinutes(startTime);
      const end = toMinutes(endTime);
      if (start == null || end == null) return { error: "time" };
      if (end <= start) return { error: "duration" };
      intervals.push({ startTime, endTime, start, end });
    }
    intervals.sort((left, right) => left.start - right.start || left.end - right.end);
    for (let index = 1; index < intervals.length; index++) {
      if (intervals[index].start < intervals[index - 1].end) return { error: "overlap" };
    }
    return { intervals: intervals.map(({ startTime, endTime }) => ({ startTime, endTime })) };
  }

  function mergedIntervals(value) {
    const intervals = (Array.isArray(value) ? value : []).flatMap((entry) => {
      const start = toMinutes(entry && entry.startTime);
      const end = toMinutes(entry && entry.endTime);
      return start != null && end != null && end > start ? [{ start, end }] : [];
    }).sort((left, right) => left.start - right.start || left.end - right.end);
    const merged = [];
    for (const interval of intervals) {
      const previous = merged[merged.length - 1];
      if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
      else merged.push({ ...interval });
    }
    return merged;
  }

  function calculate(hours, offIntervals = []) {
    const selected = normalizeHours(hours);
    const off = mergedIntervals(offIntervals);
    const slotMinutes = Object.fromEntries(HOURS.map((hour) => [hour, 0]));
    const operationRanges = [];
    let totalMinutes = 0;
    for (const hour of selected) {
      const start = toMinutes(hour);
      const end = start + 60;
      let cursor = start;
      let workedMinutes = 60;
      for (const interval of off) {
        if (interval.end <= start) continue;
        if (interval.start >= end) break;
        const offStart = Math.max(start, interval.start);
        const offEnd = Math.min(end, interval.end);
        workedMinutes -= Math.max(0, offEnd - offStart);
        if (offStart > cursor) operationRanges.push({ start: cursor, end: offStart });
        cursor = Math.max(cursor, offEnd);
      }
      if (cursor < end) operationRanges.push({ start: cursor, end });
      slotMinutes[hour] = Math.max(0, workedMinutes);
      totalMinutes += slotMinutes[hour];
    }
    const mergedOperations = [];
    for (const range of operationRanges) {
      const previous = mergedOperations[mergedOperations.length - 1];
      if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
      else mergedOperations.push({ ...range });
    }
    return { slotMinutes, totalMinutes, operationRanges: mergedOperations };
  }

  function formatOperationRanges(hours, offIntervals = [], separator = "–") {
    return calculate(hours, offIntervals).operationRanges
      .map((range) => formatTime(range.start) + separator + formatTime(range.end))
      .join(", ");
  }

  function formatHours(totalMinutes, locale = "id-ID") {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(totalMinutes / 60);
  }

  return { HOURS, MAX_OFF_INTERVALS, calculate, formatHours, formatOperationRanges, normalizeHours, normalizeOffIntervals, toMinutes };
});

