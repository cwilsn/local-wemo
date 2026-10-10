import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import cron from 'node-cron';
import { DailySchedule, validateSchedule, solarTimes } from '../src/schedule.js';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'local-wemo-test-'));
  const calls = [];
  const tasks = [];
  const timers = [];
  const setTimer = (callback, wait) => {
    const timer = { callback, wait, cleared: false };
    timers.push(timer);
    return timer;
  };
  const clearTimer = (timer) => { timer.cleared = true; };
  const file = join(directory, 'schedule.json');
  const createTask = (expression, callback, settings) => {
    const task = { expression, callback, settings, start() {}, destroy() {}, getNextRun() { return new Date('2026-10-11T23:00:00Z'); } };
    tasks.push(task);
    return task;
  };
  const schedule = await new DailySchedule({ file, createTask, setTimer, clearTimer, plug: { async setState(on) { calls.push(on); } }, ...options }).load();
  t.after(async () => { schedule.close(); await rm(directory, { recursive: true, force: true }); });
  return { schedule, file, calls, tasks, timers, createTask, setTimer, clearTimer };
}

const enabled = { enabled: true, onTime: '19:00', offTime: '23:00', timeZone: 'America/New_York' };

test('starts disabled and persists enabled times and timezone across restarts', async (t) => {
  const { schedule, file, tasks, calls, createTask } = await fixture(t);
  assert.equal(schedule.getStatus().enabled, false);
  assert.equal(tasks.length, 0);
  await schedule.save(enabled);
  assert.deepEqual(calls, []);
  assert.equal(tasks[0].expression, '0 19 * * *');
  assert.equal(tasks[1].expression, '0 23 * * *');
  assert.equal(tasks[0].settings.timezone, 'America/New_York');
  assert.equal(tasks[0].settings.noOverlap, true);
  schedule.close();
  const reloaded = await new DailySchedule({ file, createTask, plug: {} }).load();
  t.after(() => reloaded.close());
  assert.equal(reloaded.getStatus().enabled, true);
  assert.equal(reloaded.getStatus().offTime, '23:00');
});

test('scheduled on and off commands run once per local day, even after a restart', async (t) => {
  const { schedule, file, calls, createTask } = await fixture(t);
  await schedule.save(enabled);
  const when = new Date('2026-11-01T05:30:00Z');
  await schedule.run(true, when);
  await schedule.run(true, new Date('2026-11-01T06:30:00Z'));
  await schedule.run(false, when);
  assert.deepEqual(calls, [true, false]);
  schedule.close();
  const reloaded = await new DailySchedule({ file, createTask, plug: { async setState(on) { calls.push(on); } } }).load();
  t.after(() => reloaded.close());
  await reloaded.run(true, when);
  assert.deepEqual(calls, [true, false]);
  await reloaded.run(true, new Date('2026-11-02T05:30:00Z'));
  assert.deepEqual(calls, [true, false, true]);
});

test('disabled and read-only schedules never send commands', async (t) => {
  const normal = await fixture(t);
  await normal.schedule.run(true);
  assert.deepEqual(normal.calls, []);
  const readonly = await fixture(t, { readOnly: true });
  assert.throws(() => readonly.schedule.save(enabled), /read-only/);
  await readonly.schedule.run(true);
  assert.deepEqual(readonly.calls, []);
});

test('records an unconfirmed scheduled command without retrying it', async (t) => {
  let attempts = 0;
  const { schedule, file } = await fixture(t, { plug: { async setState() { attempts++; throw new Error('Plug unavailable'); } } });
  await schedule.save(enabled);
  await schedule.run(true);
  await schedule.run(true);
  assert.equal(attempts, 1);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(stored.lastRun.status, 'error');
  assert.equal(stored.lastRun.error, 'Plug unavailable');
});

test('validates overnight schedules, times, and timezone before saving', () => {
  assert.equal(validateSchedule({ ...enabled, offTime: '01:00' }).offTime, '01:00');
  for (const change of [{ onTime: '25:00' }, { offTime: '19:00' }, { enabled: 'true' }, { timeZone: 'Not/AZone' }]) {
    assert.throws(() => validateSchedule({ ...enabled, ...change }));
  }
});

test('real cron tasks use the chosen timezone, invoke the scheduler, and stop when disabled', async (t) => {
  const tasks = [];
  const { schedule, calls } = await fixture(t, {
    createTask(expression, callback, options) {
      const task = cron.createTask(expression, callback, options);
      tasks.push(task);
      return task;
    },
  });
  await schedule.save(enabled);
  const status = schedule.getStatus();
  const format = new Intl.DateTimeFormat('en-GB', {
    timeZone: enabled.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  assert.equal(format.format(new Date(status.nextOn)), '19:00');
  assert.equal(format.format(new Date(status.nextOff)), '23:00');
  assert.deepEqual(calls, []);
  await tasks[0].execute();
  await tasks[0].execute();
  await tasks[1].execute();
  assert.deepEqual(calls, [true, false]);
  assert.equal(schedule.getStatus().lastRun.status, 'success');
  await schedule.save({ ...enabled, enabled: false });
  assert.equal(schedule.getStatus().nextOn, null);
  assert.equal(schedule.getStatus().nextOff, null);
  assert.ok(tasks.every((task) => task.getStatus() === 'destroyed'));
});

const sunsetSchedule = { ...enabled, onMode: 'sunset' };
const localDay = (date) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(date);

test('solar calculations follow the chosen calendar day near UTC midnight and DST changes', () => {
  const morning = solarTimes(new Date('2026-10-10T12:00:00Z'), 'America/New_York');
  const late = solarTimes(new Date('2026-10-11T03:59:00Z'), 'America/New_York');
  assert.equal(late.sunset.getTime(), morning.sunset.getTime());
  assert.equal(localDay(late.sunset), '2026-10-10');
  assert.ok(late.dusk > late.sunset);
  for (const [early, noon] of [
    ['2026-03-08T05:30:00Z', '2026-03-08T16:00:00Z'],
    ['2026-11-01T04:30:00Z', '2026-11-01T17:00:00Z'],
  ]) {
    const first = solarTimes(new Date(early), 'America/New_York').sunset;
    const second = solarTimes(new Date(noon), 'America/New_York').sunset;
    assert.ok(Math.abs(first - second) < 1000);
  }
});

test('sunset arms a future timer, runs once, and recalculates tomorrow', async (t) => {
  let clock = new Date('2026-10-10T12:00:00Z');
  const { schedule, calls, tasks, timers } = await fixture(t, { now: () => clock });
  await schedule.save(sunsetSchedule);
  const sunset = new Date(schedule.getStatus().nextOn);
  assert.equal(sunset.getTime(), solarTimes(clock, enabled.timeZone).sunset.getTime());
  assert.deepEqual(schedule.getStatus().location, { latitude: 34.22, longitude: -77.94 });
  assert.equal(tasks[0].expression, '0 0 * * *');
  assert.equal(tasks[1].expression, '0 23 * * *');
  assert.equal(timers[0].wait, sunset - clock);
  assert.deepEqual(calls, []);
  clock = sunset;
  await timers[0].callback();
  await timers[0].callback();
  assert.deepEqual(calls, [true]);
  assert.equal(localDay(new Date(schedule.getStatus().nextOn)), '2026-10-11');
  assert.notEqual(schedule.getStatus().nextOn, sunset.toISOString());
});

test('midnight refresh replaces the sunset timer without sending a command', async (t) => {
  let clock = new Date('2026-10-11T03:59:00Z');
  const { schedule, calls, tasks, timers } = await fixture(t, { now: () => clock });
  await schedule.save(sunsetSchedule);
  const next = schedule.getStatus().nextOn;
  clock = new Date('2026-10-11T04:00:00Z');
  await tasks[0].callback();
  assert.equal(timers[0].cleared, true);
  assert.equal(schedule.getStatus().nextOn, next);
  await timers[0].callback();
  assert.deepEqual(calls, []);
  clock = new Date(next);
  await timers[1].callback();
  assert.deepEqual(calls, [true]);
});

test('sunset settings survive a restart after sunset without catching up immediately', async (t) => {
  const clock = new Date('2026-10-10T23:30:00Z');
  const { schedule, file, calls, createTask, setTimer, clearTimer } = await fixture(t, { now: () => clock });
  await schedule.save(sunsetSchedule);
  const next = schedule.getStatus().nextOn;
  schedule.close();
  const restored = await new DailySchedule({
    file, createTask, setTimer, clearTimer, now: () => clock,
    plug: { async setState(on) { calls.push(on); } },
  }).load();
  t.after(() => restored.close());
  assert.equal(restored.getStatus().onMode, 'sunset');
  assert.equal(restored.getStatus().nextOn, next);
  assert.equal(localDay(new Date(next)), '2026-10-11');
  assert.deepEqual(calls, []);
});

test('next sunset stays on the next local date across short and long DST days', async (t) => {
  for (const [now, expected] of [
    ['2026-03-09T03:30:00Z', '2026-03-09'],
    ['2026-11-01T04:30:00Z', '2026-11-01'],
    ['2026-11-02T04:30:00Z', '2026-11-02'],
  ]) {
    const clock = new Date(now);
    const { schedule } = await fixture(t, { now: () => clock });
    await schedule.save(sunsetSchedule);
    const next = new Date(schedule.getStatus().nextOn);
    assert.equal(localDay(next), expected);
    assert.ok(next > clock);
  }
});

test('pausing sunset cancels its timer and read-only startup never arms one', async (t) => {
  let clock = new Date('2026-10-10T12:00:00Z');
  const { schedule, file, calls, timers, createTask, setTimer, clearTimer } = await fixture(t, { now: () => clock });
  await schedule.save(sunsetSchedule);
  const sunset = new Date(schedule.getStatus().nextOn);
  schedule.close();
  const readonly = await new DailySchedule({
    file, createTask, setTimer, clearTimer, now: () => clock, readOnly: true,
    plug: { async setState(on) { calls.push(on); } },
  }).load();
  t.after(() => readonly.close());
  assert.equal(readonly.getStatus().nextOn, null);
  assert.equal(timers.length, 1);
  await schedule.save({ ...sunsetSchedule, enabled: false });
  clock = sunset;
  await timers[0].callback();
  assert.equal(timers[0].cleared, true);
  assert.equal(schedule.getStatus().nextOn, null);
  assert.deepEqual(calls, []);
});

test('a sunset timer delayed past its grace period skips the missed change', async (t) => {
  let clock = new Date('2026-10-10T12:00:00Z');
  const { schedule, calls, timers } = await fixture(t, { now: () => clock });
  await schedule.save(sunsetSchedule);
  const sunset = new Date(schedule.getStatus().nextOn);
  clock = new Date(sunset.getTime() + 120_000);
  await timers[0].callback();
  assert.deepEqual(calls, []);
  assert.equal(localDay(new Date(schedule.getStatus().nextOn)), '2026-10-11');
});

test('legacy fixed-time schedules load normally and sunset ignores the unused fixed on-time', () => {
  assert.equal(validateSchedule(enabled).onMode, 'time');
  assert.equal(validateSchedule({ ...sunsetSchedule, offTime: '19:00' }).onMode, 'sunset');
  assert.throws(() => validateSchedule({ ...enabled, onMode: 'dusk' }));
});

test('a sunset change queued behind a settings update cannot run the old schedule', async (t) => {
  let clock = new Date('2026-10-10T12:00:00Z');
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const applied = [];
  const { schedule, timers } = await fixture(t, {
    now: () => clock,
    plug: { async setState(on) {
      applied.push(on);
      if (applied.length === 1) {
        entered();
        await gate;
      }
    } },
  });
  await schedule.save(sunsetSchedule);
  const active = schedule.run(false);
  await started;
  clock = new Date(schedule.getStatus().nextOn);
  const saving = schedule.save({ ...enabled, onTime: '20:00' });
  const sunset = timers[0].callback();
  release();
  await Promise.all([active, saving, sunset]);
  assert.deepEqual(applied, [false]);
  assert.equal(schedule.getStatus().onMode, 'time');
  assert.equal(timers.length, 1);
  await timers[0].callback();
  assert.deepEqual(applied, [false]);
});
