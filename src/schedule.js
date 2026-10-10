import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import cron from 'node-cron';
import * as SunCalc from 'suncalc';

export const HOME_LOCATION = { latitude: 34.22, longitude: -77.94 };
const DEFAULTS = { enabled: false, onMode: 'time', onTime: '19:00', offTime: '23:00', timeZone: 'America/New_York' };

export function solarTimes(when, timeZone) {
  const zone = new Intl.DateTimeFormat('en', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(when).find((part) => part.type === 'timeZoneName').value;
  const match = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(zone);
  if (!match) {
    throw new Error('Could not determine the timezone offset for sunset.');
  }
  const offset = match[1] ? (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : 0;
  return SunCalc.getTimes(when, HOME_LOCATION.latitude, HOME_LOCATION.longitude, 0, offset);
}

export function validateSchedule(value) {
  const validTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  const onMode = value?.onMode ?? 'time';
  if (!value || typeof value.enabled !== 'boolean' || !['time', 'sunset'].includes(onMode)
    || typeof value.onTime !== 'string' || !validTime.test(value.onTime)
    || typeof value.offTime !== 'string' || !validTime.test(value.offTime)
    || (onMode === 'time' && value.onTime === value.offTime) || typeof value.timeZone !== 'string') {
    throw new Error('Choose an On mode, different fixed times, and a valid timezone.');
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: value.timeZone }).format();
  } catch {
    throw new Error('Choose a valid timezone, such as America/New_York.');
  }
  return { enabled: value.enabled, onMode, onTime: value.onTime, offTime: value.offTime, timeZone: value.timeZone };
}

export class DailySchedule {
  #tasks = [];
  #queue = Promise.resolve();
  #sunsetTimer;
  #nextSunset;
  #generation = 0;

  constructor({ plug, file, readOnly = false, createTask = cron.createTask,
    now = () => new Date(), setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.plug = plug;
    this.file = file;
    this.readOnly = readOnly;
    this.createTask = createTask;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.settings = { ...DEFAULTS };
    this.lastRun = null;
    this.lastFired = {};
  }

  async load() {
    try {
      const stored = JSON.parse(await readFile(this.file, 'utf8'));
      this.settings = validateSchedule(stored.settings);
      this.lastRun = stored.lastRun || null;
      this.lastFired = stored.lastFired || {};
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new Error(`Could not load the saved schedule: ${error.message}`);
      }
    }
    this.#restartTasks();
    return this;
  }

  #serialize(operation) {
    const result = this.#queue.then(operation);
    this.#queue = result.catch(() => {});
    return result;
  }

  async #persist(settings = this.settings) {
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    await writeFile(temp, JSON.stringify({ settings, lastRun: this.lastRun, lastFired: this.lastFired }, null, 2) + '\n', { mode: 0o600 });
    await rename(temp, this.file);
  }

  #armSunset() {
    if (!this.settings.enabled || this.readOnly || this.settings.onMode !== 'sunset') {
      return;
    }
    if (this.#sunsetTimer !== undefined) {
      this.clearTimer(this.#sunsetTimer);
    }
    this.#sunsetTimer = undefined;
    const now = this.now();
    // Half-day samples cover the next local day even across 23- and 25-hour DST days.
    const sunsets = [0, 12, 24, 36].map((hours) => solarTimes(
      new Date(now.getTime() + hours * 3_600_000), this.settings.timeZone,
    ).sunset).filter((date) => date && Number.isFinite(date.getTime()) && date > now);
    const sunset = sunsets.sort((a, b) => a - b)[0];
    this.#nextSunset = sunset;
    if (!sunset) {
      return;
    }
    const generation = this.#generation;
    this.#sunsetTimer = this.setTimer(async () => {
      if (generation !== this.#generation || this.#nextSunset !== sunset) {
        return;
      }
      this.#sunsetTimer = undefined;
      const lateBy = this.now().getTime() - sunset.getTime();
      try {
        if (lateBy >= 0 && lateBy < 60_000) {
          await this.run(true, sunset, generation);
        }
      } catch (error) {
        console.error(`Schedule: ${error.message}`);
      } finally {
        if (generation === this.#generation) {
          this.#armSunset();
        }
      }
    }, sunset.getTime() - now.getTime());
  }

  #restartTasks() {
    this.close();
    if (!this.settings.enabled || this.readOnly) {
      return;
    }
    const generation = this.#generation;
    for (const [action, time] of [['on', this.settings.onTime], ['off', this.settings.offTime]]) {
      const isSunset = action === 'on' && this.settings.onMode === 'sunset';
      const [hour, minute] = time.split(':').map(Number);
      const expression = isSunset ? '0 0 * * *' : `${minute} ${hour} * * *`;
      const callback = isSunset ? () => this.#armSunset() : (context) => this.run(action === 'on', context.date, generation);
      const task = this.createTask(expression, callback, {
        timezone: this.settings.timeZone, noOverlap: true, name: isSunset ? 'wemo-sunset-refresh' : `wemo-${action}`,
        missedExecutionTolerance: 60_000,
      });
      this.#tasks.push(task);
      task.start();
    }
    if (this.settings.onMode === 'sunset') {
      this.#armSunset();
    }
  }

  getStatus() {
    const times = solarTimes(this.now(), this.settings.timeZone);
    const isSunset = this.settings.onMode === 'sunset';
    return { ...this.settings, readOnly: this.readOnly, lastRun: this.lastRun,
      location: HOME_LOCATION, sunset: times.sunset?.toISOString() || null, dusk: times.dusk?.toISOString() || null,
      nextOn: (isSunset ? this.#nextSunset : this.#tasks[0]?.getNextRun())?.toISOString() || null,
      nextOff: this.#tasks[1]?.getNextRun()?.toISOString() || null };
  }

  save(value) {
    const settings = validateSchedule(value);
    if (this.readOnly && settings.enabled) {
      throw new Error('Schedules cannot be enabled in read-only mode.');
    }
    return this.#serialize(async () => {
      await this.#persist(settings);
      this.settings = settings;
      this.#restartTasks();
      return this.getStatus();
    });
  }

  run(on, when = this.now(), generation) {
    return this.#serialize(async () => {
      if (!this.settings.enabled || this.readOnly
        || (generation !== undefined && generation !== this.#generation)) {
        return;
      }
      const action = on ? 'on' : 'off';
      const localDate = new Intl.DateTimeFormat('en-CA', {
        timeZone: this.settings.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(when);
      const onKey = this.settings.onMode === 'sunset' ? 'sunset' : this.settings.onTime;
      const key = `${localDate}|${on ? onKey : this.settings.offTime}`;
      if (this.lastFired[action] === key) {
        return;
      }
      this.lastFired[action] = key;
      this.lastRun = { action, at: this.now().toISOString(), status: 'pending' };
      await this.#persist();
      try {
        await this.plug.setState(on);
        this.lastRun.status = 'success';
        console.log(`Schedule: lights turned ${action}.`);
      } catch (error) {
        this.lastRun.status = 'error';
        this.lastRun.error = error.message;
        console.error(`Schedule: ${error.message}`);
      }
      await this.#persist();
    });
  }

  close() {
    this.#generation += 1;
    if (this.#sunsetTimer !== undefined) {
      this.clearTimer(this.#sunsetTimer);
    }
    this.#sunsetTimer = undefined;
    this.#nextSunset = undefined;
    for (const task of this.#tasks) {
      task.destroy();
    }
    this.#tasks = [];
  }
}
