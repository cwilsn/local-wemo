const $ = (id) => document.getElementById(id);
let token;
let readOnly = false;
let currentState;
let busy = false;
let refreshing = false;
let stateVersion = 0;
let scheduleReady = false;
let scheduleDirty = false;
let saving = false;
let sunsetInfo;

async function api(path, value) {
  const options = { signal: AbortSignal.timeout(20_000), cache: 'no-store' };
  if (value !== undefined) {
    Object.assign(options, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Wemo-Token': token,
    }, body: JSON.stringify(value) });
  }
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Something went wrong. Try again.');
  }
  return data;
}

function buttons() {
  $('powerButton').disabled = busy || readOnly || typeof currentState !== 'boolean';
  $('refreshButton').disabled = busy;
  $('saveButton').disabled = !scheduleReady || saving || readOnly;
  $('scheduleEnabled').disabled = readOnly || !scheduleReady || saving;
  $('onMode').disabled = readOnly || !scheduleReady || saving;
  $('onTime').disabled = readOnly || !scheduleReady || saving || $('onMode').value === 'sunset';
  $('offTime').disabled = readOnly || !scheduleReady || saving;
  $('timeZone').disabled = readOnly || !scheduleReady || saving;
}

function showState(state) {
  currentState = state.on;
  $('deviceName').textContent = state.name;
  document.title = `${state.name} · Local Wemo`;
  $('lightCard').dataset.power = state.on ? 'on' : 'off';
  $('stateBadge').textContent = state.on ? 'ON' : 'OFF';
  $('powerText').textContent = state.on ? 'Your lights are on.' : 'Your lights are off.';
  $('powerButtonText').textContent = state.on ? 'Turn lights off' : 'Turn lights on';
  $('powerButton').setAttribute('aria-label', `${state.on ? 'Turn off' : 'Turn on'} ${state.name}`);
  $('lightNote').textContent = state.on ? 'A little warmth for the way home.' : 'Ready whenever you need a little light.';
  $('connection').dataset.status = 'online';
  $('connectionText').textContent = 'Connected';
  $('controlError').hidden = true;
}

function showError(error) {
  currentState = undefined;
  $('lightCard').dataset.power = 'unknown';
  $('stateBadge').textContent = '—';
  $('powerText').textContent = 'Let’s reconnect.';
  $('powerButtonText').textContent = 'Waiting for your plug';
  $('lightNote').textContent = 'Refresh when your plug is back on the network.';
  $('connection').dataset.status = 'offline';
  $('connectionText').textContent = 'Unavailable';
  $('controlError').textContent = error.name === 'TimeoutError' ? 'The plug is taking longer than expected. Try refreshing.' : error.message;
  $('controlError').hidden = false;
}

async function refreshState({ background = false } = {}) {
  if (busy || refreshing || !token) {
    return;
  }
  refreshing = true;
  const version = stateVersion;
  if (!background) {
    busy = true;
    buttons();
  }
  try {
    const state = await api('api/state');
    if (version === stateVersion) {
      showState(state);
    }
  } catch (error) {
    if (version === stateVersion) {
      showError(error);
    }
  } finally {
    refreshing = false;
    if (!background) {
      busy = false;
    }
    buttons();
  }
}

const zoneLabels = new Map([
  ['America/New_York', 'New York · Eastern'], ['America/Chicago', 'Chicago · Central'],
  ['America/Denver', 'Denver · Mountain'], ['America/Los_Angeles', 'Los Angeles · Pacific'],
  ['America/Phoenix', 'Phoenix · Arizona'], ['UTC', 'UTC'],
]);

function populateTimezones(current) {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zones = new Set([...zoneLabels.keys(), current, local,
    ...(Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [])]);
  $('timeZone').replaceChildren();
  for (const zone of zones) {
    const option = document.createElement('option');
    option.value = zone;
    option.textContent = zoneLabels.get(zone) || zone.replaceAll('_', ' ').replace('/', ' · ');
    $('timeZone').append(option);
  }
  $('timeZone').value = current;
}

function showNextEvent(schedule) {
  const events = [schedule.nextOn && { on: true, at: new Date(schedule.nextOn) },
    schedule.nextOff && { on: false, at: new Date(schedule.nextOff) }].filter(Boolean).sort((a, b) => a.at - b.at);
  const next = events[0];
  if (!schedule.enabled || readOnly || !next) {
    $('nextEventText').textContent = 'You’re in control. Scheduling is paused.';
    return;
  }
  const time = new Intl.DateTimeFormat(undefined, { timeZone: schedule.timeZone, hour: 'numeric', minute: '2-digit' }).format(next.at);
  $('nextEventText').textContent = `Next: lights ${next.on ? 'on' : 'off'} at ${time}`;
}

function showOnMode() {
  const atSunset = $('onMode').value === 'sunset';
  $('onTimeField').hidden = atSunset;
  $('sunsetField').hidden = !atSunset;
  $('sunsetTime').textContent = sunsetInfo?.sunset ? new Intl.DateTimeFormat(undefined, {
    timeZone: sunsetInfo.timeZone, hour: 'numeric', minute: '2-digit',
  }).format(new Date(sunsetInfo.sunset)) : 'Unavailable';
  $('scheduleHint').textContent = atSunset
    ? 'Sunset adjusts each day for your home’s location.'
    : 'Repeats every day. The Pi keeps time for you.';
  buttons();
}

function showSchedule(schedule, updateForm = true) {
  scheduleReady = true;
  sunsetInfo = { sunset: schedule.sunset, timeZone: schedule.timeZone };
  $('scheduleBadge').textContent = schedule.enabled && !readOnly ? 'ACTIVE' : 'PAUSED';
  $('scheduleBadge').dataset.enabled = String(schedule.enabled && !readOnly);
  if (updateForm) {
    $('scheduleEnabled').checked = schedule.enabled;
    $('onMode').value = schedule.onMode || 'time';
    $('onTime').value = schedule.onTime;
    $('offTime').value = schedule.offTime;
    populateTimezones(schedule.timeZone);
  }
  showOnMode();
  if (schedule.lastRun?.status === 'error') {
    $('scheduleFootnote').textContent = `Last scheduled change failed: ${schedule.lastRun.error}`;
  } else {
    $('scheduleFootnote').textContent = 'Keep your Pi running for scheduled changes.';
  }
  showNextEvent(schedule);
  buttons();
}

$('powerButton').addEventListener('click', async () => {
  if (busy || readOnly || typeof currentState !== 'boolean') {
    return;
  }
  const on = !currentState;
  stateVersion += 1;
  busy = true;
  buttons();
  $('powerButtonText').textContent = on ? 'Turning on…' : 'Turning off…';
  try {
    showState(await api('api/state', { on }));
  } catch (error) {
    showError(error);
  } finally {
    busy = false;
    buttons();
  }
});

$('refreshButton').addEventListener('click', () => refreshState());
$('scheduleForm').addEventListener('input', () => {
  scheduleDirty = true;
  showOnMode();
  $('scheduleMessage').textContent = 'Unsaved changes';
  $('scheduleMessage').dataset.error = 'false';
});
$('scheduleForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (saving || !scheduleReady || readOnly) {
    return;
  }
  if ($('onMode').value !== 'sunset' && $('onTime').value === $('offTime').value) {
    $('scheduleMessage').textContent = 'Choose different On and Off times.';
    $('scheduleMessage').dataset.error = 'true';
    return;
  }
  saving = true;
  buttons();
  $('saveButtonText').textContent = 'Saving…';
  try {
    const schedule = await api('api/schedule', { enabled: $('scheduleEnabled').checked,
      onMode: $('onMode').value || 'time', onTime: $('onTime').value, offTime: $('offTime').value, timeZone: $('timeZone').value });
    scheduleDirty = false;
    showSchedule(schedule);
    $('scheduleMessage').textContent = schedule.enabled ? 'Saved. We’ll take care of the lights.' : 'Saved. Daily scheduling is paused.';
    $('scheduleMessage').dataset.error = 'false';
  } catch (error) {
    $('scheduleMessage').textContent = error.message;
    $('scheduleMessage').dataset.error = 'true';
  } finally {
    saving = false;
    $('saveButtonText').textContent = 'Save schedule';
    buttons();
  }
});

async function start() {
  buttons();
  try {
    const config = await api('api/config');
    token = config.token;
    readOnly = config.readOnly;
    $('readOnlyNotice').hidden = !readOnly;
    showSchedule(await api('api/schedule'));
    await refreshState();
  } catch (error) {
    showError(error);
    $('scheduleMessage').textContent = 'Couldn’t load the app. Reload this page to try again.';
    $('scheduleMessage').dataset.error = 'true';
  }
  buttons();
}

setInterval(async () => {
  if (document.hidden || busy || saving || !token) {
    return;
  }
  await refreshState({ background: true });
  if (!scheduleDirty) {
    try {
      showSchedule(await api('api/schedule'), false);
    } catch {
      // Keep the last saved schedule visible during a temporary connection problem.
    }
  }
}, 15_000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    if (token) {
      refreshState({ background: true });
    } else {
      start();
    }
  }
});
start();
