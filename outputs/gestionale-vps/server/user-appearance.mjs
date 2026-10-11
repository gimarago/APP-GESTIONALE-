import { HttpError } from './validation.mjs';

const themes = Object.freeze({
  graphite: { primary: '#285462', accent: '#64d8ef' },
  aurora: { primary: '#693589', accent: '#c8adff' },
  classic: { primary: '#143d32', accent: '#d9fc52' }
});
const color = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
const defaults = () => ({ theme: 'graphite', ...themes.graphite });
const userId = auth => {
  if (!Number.isSafeInteger(auth?.id) || auth.id <= 0) throw new HttpError(401, 'AUTH_REQUIRED', 'Accedi per salvare il tema personale.');
  return auth.id;
};
function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).some(key => !['theme', 'primary', 'accent'].includes(key)) ||
      !Object.hasOwn(themes, value.theme) || !color(value.primary) || !color(value.accent)) {
    throw new HttpError(400, 'INVALID_APPEARANCE', 'Seleziona un tema valido e colori nel formato #RRGGBB.');
  }
  return { theme: value.theme, primary: value.primary.toLowerCase(), accent: value.accent.toLowerCase() };
}

// Appearance belongs to a login account. It is deliberately outside shared
// workshop records, versions and events, including for read-only accounts.
export function appearanceStore(db, now = Date.now) {
  db.exec(`CREATE TABLE IF NOT EXISTS user_appearance (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    theme TEXT NOT NULL CHECK(theme IN ('graphite','aurora','classic')),
    primary_color TEXT NOT NULL,
    accent_color TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  const read = auth => {
    const stored = db.prepare('SELECT theme,primary_color AS primaryColor,accent_color AS accentColor FROM user_appearance WHERE user_id=?').get(userId(auth));
    if (!stored) return defaults();
    return validate({ theme: stored.theme, primary: stored.primaryColor, accent: stored.accentColor });
  };
  const save = (auth, value) => {
    const id = userId(auth), state = validate(value);
    db.prepare(`INSERT INTO user_appearance(user_id,theme,primary_color,accent_color,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET theme=excluded.theme,primary_color=excluded.primary_color,
      accent_color=excluded.accent_color,updated_at=excluded.updated_at`).run(id, state.theme, state.primary, state.accent, now());
    return state;
  };
  return { read, save };
}
