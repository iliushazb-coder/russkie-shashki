// Минимальный, но буквальный интерпретатор Firebase RTDB Rules-выражений.
// Не эмулятор -- не тестирует multi-path atomicity/commit-семантику RTDB
// целиком. Тестирует РЕАЛЬНОЕ ИСПОЛНЕНИЕ конкретных строк-предикатов
// (buildRoomWrite/.validate и т.д.) против сконструированных data/newData,
// используя ту же JS-грамматику, в которой написаны сами правила.
//
// НАЙДЕНО НА PR #6 CI (официальный Firebase Emulator, backend suite):
// harness раньше давал FakeSnapshot собственный .matches() -- метод,
// которого у RuleDataSnapshot в РЕАЛЬНОМ Firebase RTDB Rules нет вовсе.
// Задокументированные методы snapshot: val/exists/child/parent/hasChild/
// hasChildren/isString/isNumber/isBoolean/getPriority -- matches() среди
// них отсутствует. .matches() существует только как метод СТРОКИ (уже
// подтверждено собственным, годами работающим кодом в этом же файле:
// "$seq.matches(...)" на wildcard-переменной и "newData.val().matches(...)"
// после явного .val()). Из-за этого расхождения harness давал ложный
// GREEN на newData.child('seq').matches(...) -- невалидное выражение,
// которое реальный emulator корректно отклонил с
// "No such method/property 'matches'". Теперь FakeSnapshot НЕ имеет
// .matches(), а String.prototype.matches полифиллится ниже -- та же
// граница возможностей, что у настоящих Firebase Rules.

if (typeof String.prototype.matches !== "function") {
  // eslint-disable-next-line no-extend-native
  String.prototype.matches = function (regex) { return regex.test(this); };
}

class FakeSnapshot {
  constructor(root, path) {
    this._root = root;
    this._path = path; // массив сегментов от корня, [] = сам корень
  }
  _resolve() {
    let v = this._root;
    for (const seg of this._path) {
      v = (v !== null && typeof v === 'object') ? v[seg] : undefined;
    }
    return v;
  }
  val() {
    const v = this._resolve();
    return v === undefined ? null : v;
  }
  exists() {
    const v = this._resolve();
    return v !== undefined && v !== null;
  }
  child(path) {
    const parts = String(path).split('/').filter(Boolean);
    return new FakeSnapshot(this._root, this._path.concat(parts));
  }
  hasChild(path) { return this.child(path).exists(); }
  hasChildren(list) {
    const v = this._resolve();
    if (!list) return v !== null && typeof v === 'object' && Object.keys(v).length > 0;
    return list.every((k) => this.child(k).exists());
  }
  isString() { return typeof this._resolve() === 'string'; }
  isNumber() { return typeof this._resolve() === 'number'; }
  isBoolean() { return typeof this._resolve() === 'boolean'; }
  // НЕТ .matches() здесь намеренно -- см. комментарий вверху файла.
  parent() {
    if (this._path.length === 0) return this;
    return new FakeSnapshot(this._root, this._path.slice(0, -1));
  }
}

// evalRule(exprText, {authUid, dataTree, newDataTree, rootTree, now, wildcards})
// dataTree/newDataTree -- значение узла, на котором стоит правило (не корня).
// rootTree -- полное дерево БД для root.child(...) внутри правила.
// wildcards -- объект вида {$room: 'ABC123', $matchId: '...'} -- подставляется
// как обычные переменные перед вычислением (buildFunction ниже).
function evalRule(exprText, opts) {
  const auth = opts.authUid === null ? null : { uid: opts.authUid };
  const data = new FakeSnapshot(opts.rootTree, opts.dataPath || []);
  const newData = new FakeSnapshot(opts.rootTree2 !== undefined ? opts.rootTree2 : opts.rootTree, opts.dataPath || []);
  // newData должен смотреть на ДЕРЕВО ПОСЛЕ гипотетической записи, а data --
  // на дерево ДО неё. rootTree2 передаётся отдельно, если различаются;
  // если нет -- считаем newData тем же деревом с точечно применённым
  // изменением через opts.newValue (упрощение для однопутевых кейсов).
  const root = new FakeSnapshot(opts.rootTree2 !== undefined ? opts.rootTree2 : opts.rootTree, []);
  const now = opts.now;
  const localVars = Object.assign({}, opts.wildcards || {});
  const varNames = Object.keys(localVars);
  const varValues = varNames.map((k) => localVars[k]);
  // eslint-disable-next-line no-new-func
  const fn = new Function('auth', 'data', 'newData', 'root', 'now', ...varNames,
    'return (' + exprText + ');');
  return fn(auth, data, newData, root, now, ...varValues);
}

module.exports = { FakeSnapshot, evalRule };
