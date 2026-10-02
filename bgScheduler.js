/* =====================================================================
 * Планувальник таймерів, стійкий до фону (TASK-016).
 *
 * Таймери JS у React Native (JavaTimerManager) прив'язані до Choreographer і
 * призупиняються, коли застосунок у фоні або екран вимкнено. Тут кожен таймер
 * спрацьовує від того, що настане раніше:
 *   1) нативного такту 50 мс (App.js викликає bgTick на кожну подію nativeSensors,
 *      вона приходить з окремого нативного потоку і від фону не залежить);
 *   2) звичайного setTimeout (запасний шлях, якщо нативних тактів немає).
 * ===================================================================== */

const tasks = new Map();
let nextId = 1;

export function setBgTimeout(fn, ms) {
  const id = nextId++;
  const t = { due: Date.now() + ms, done: false, real: null, fn };
  t.run = () => {
    if (t.done) return;
    t.done = true;
    if (t.real) clearTimeout(t.real);
    tasks.delete(id);
    fn();
  };
  t.real = setTimeout(t.run, ms);
  tasks.set(id, t);
  return id;
}

export function clearBgTimeout(id) {
  const t = tasks.get(id);
  if (!t) return;
  t.done = true;
  if (t.real) clearTimeout(t.real);
  tasks.delete(id);
}

/** Викликається на кожен нативний такт. */
export function bgTick(nowMs = Date.now()) {
  if (tasks.size === 0) return;
  for (const t of Array.from(tasks.values())) {
    if (!t.done && nowMs >= t.due) {
      try {
        t.run();
      } catch (e) {
        console.error('[bgScheduler] Помилка в таймері:', e);
      }
    }
  }
}

export function setBgInterval(fn, ms) {
  const handle = { cancelled: false, timer: null };
  let due = Date.now() + ms;
  const schedule = () => {
    handle.timer = setBgTimeout(() => {
      if (handle.cancelled) return;
      const now = Date.now();
      due += ms;
      if (due < now) due = now + ms; // після довгої паузи не «наздоганяємо» пачкою
      schedule();
      fn();
    }, Math.max(0, due - Date.now()));
  };
  schedule();
  return handle;
}

export function clearBgInterval(handle) {
  if (!handle) return;
  handle.cancelled = true;
  clearBgTimeout(handle.timer);
}
