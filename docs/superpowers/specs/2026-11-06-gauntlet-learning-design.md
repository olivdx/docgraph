# Gauntlet learning: Design

Ngày: 2026-11-06
Trạng thái: Design đã được owner duyệt qua thảo luận (mục tiêu D: tránh nước sai + mở rộng book). Các lựa chọn còn lại do Claude chốt theo ủy quyền của owner.
Bổ sung cho: `2026-11-02-caro-tournament-design.md` (mục "Gauntlet bot engine").

## 1. Mục tiêu

Bot Gauntlet (độ khó cao nhất) **lưu lại mọi ván nó chơi với người** và **tự học** từ kết quả:

- Nước đi dẫn tới thua, gặp lại nhiều lần, bị hạ điểm rồi loại khỏi danh sách ứng viên.
- Nước đi trong ván thắng được cộng điểm, nên được ưu tiên hơn khi gặp lại thế cờ đó.

Không làm: học theo từng người chơi, dashboard xem replay, xuất book tĩnh vào code, phân tích offline sâu, học từ Prelude/Duel. Các mục này là bước sau nếu cần.

## 2. Tổng quan kiến trúc

Hai collection mới trong DB `caro`:

| Collection | Nội dung | TTL |
|---|---|---|
| `gauntlet_games` | Replay mỗi ván Gauntlet vs người đã kết thúc | 90 ngày |
| `gauntlet_book` | Thống kê theo **thế cờ chuẩn hoá** (canonical): mỗi nước bot từng đánh → `w`, `n`, `wins`, `losses` | không |

Luồng:

```
Request của người chơi tới match (poll / move)
  │
  ├─ (a) Trước khi settle: nếu match là người-vs-Gauntlet và bot sắp đi,
  │      đọc gauntlet_book cho thế hiện tại (timeout 150 ms; lỗi/miss = không có hint)
  │      → SettleOpts.hints
  │
  ├─ settle → chooseBotMove(..., { hints }) → chooseGauntletMove:
  │      book tĩnh 3 nước đầu như cũ → loại nước "đỏ" → bias ordering/root → PVS/VCT như cũ
  │
  └─ (b) Sau khi ghi Mongo thành công: so sánh room trước/sau,
         ván người-vs-Gauntlet vừa kết thúc → recordGame (chạy trong `after()`)
         → insert gauntlet_games (idempotent) → cập nhật gauntlet_book
```

Nguyên tắc: **engine đồng bộ và thuần** (không đụng Mongo); mọi I/O nằm trong `RoomService` / store. Lỗi I/O chỉ log, không bao giờ làm fail request hay đổi luật chơi.

## 3. Thành phần

### 3.1 `src/game/gauntlet-learn.ts` (thuần TS, không I/O)

- `canonicalPosition(moves: Move[]): { key: string; toCanon(c: Cell): Cell; fromCanon(c: Cell): Cell }`
  - Áp 8 đối xứng quanh (0,0) (xoay 0/90/180/270 × lật). Bàn là −50..49 nên một đối xứng có thể đẩy ô ra toạ độ 50 (ngoài bàn): đối xứng đó bị **bỏ qua**. Đối xứng gốc luôn hợp lệ.
  - Với mỗi đối xứng hợp lệ, tạo chuỗi `X:<x,y;...>|O:<x,y;...>` (các ô sắp xếp tăng dần). Chọn chuỗi nhỏ nhất theo thứ tự từ điển làm chuỗi chuẩn.
  - `key` = FNV-1a 64-bit (hai nửa 32-bit) của chuỗi chuẩn, dạng hex 16 ký tự. `key` không chứa phía sắp đi; phía sắp đi được lưu riêng trong document.
- `type HintEntry = { w: number; n: number; wins: number; losses: number }`
- `type BookDoc = { _id: string; side: Side; moves: Record<string, HintEntry>; updatedAt: number }` — khoá `moves` là `"x,y"` **trong hệ toạ độ chuẩn**.
- `type GauntletHints = Map<string, HintEntry>` — khoá `"x,y"` **trong hệ toạ độ bàn thật** (đã `fromCanon`). Đây là thứ engine nhận.
- `hintsFromDoc(doc: BookDoc | null, pos): GauntletHints` — đổi toạ độ chuẩn → bàn thật.
- `type GameRecord = { _id: string; roomCode: string; matchId: string; gameIndex: number; moves: Move[]; botSide: Side; winnerSide: Side; endReason: 'five_in_row' | 'resign'; createdAt: number }` với `_id = "<roomCode>:<matchId>:<gameIndex>"` (`gameIndex` = `games.length` sau khi ván được ghi, 1-based).
- `type BookDelta = { key: string; side: Side; cell: string /* "x,y" canonical */; delta: number; won: boolean }`
- `deltasFromGame(rec: GameRecord, isForced: (moves: Move[], side: Side) => boolean, inBook: (moves: Move[], side: Side) => boolean): BookDelta[]`
  - Lấy các nước của bot theo thứ tự, **bỏ** nước mà `inBook` (book tĩnh đã trả lời) hoặc `isForced` (ăn 5, chặn 5, mở 4 có sẵn).
  - Với `k` nước còn lại, nước thứ `i` (0-based):
    - bot thắng: `delta = +1`
    - bot thua: `delta = −(1 + 2·(i+1)/k)` (−1 ở đầu ván … −3 ở nước cuối)
  - Thế cờ dùng để tính `key` là **trước** nước đó.
- Hằng số: `HINT_MIN_N = 3`, `HINT_BAN_W = -3`, `HINT_BONUS = 2000`, `HINT_BONUS_CAP = 20000`.
- `filterByHints(cells: Cell[], hints: GauntletHints): Cell[]` — loại ô có `n ≥ HINT_MIN_N && w ≤ HINT_BAN_W`; nếu loại hết thì trả về nguyên danh sách.
- `hintBonus(cell: Cell, hints: GauntletHints): number` — `clamp(w · HINT_BONUS, −CAP, +CAP)`, 0 nếu không có.

### 3.2 `src/game/bot-gauntlet.ts` (sửa)

- `GauntletOptions.hints?: GauntletHints`.
- Export `isForcedPosition(moves: Move[], side: Side): boolean` — dùng `GauntletEngine`: `n5[me] > 0 || n5[opp] > 0 || n4o[me] > 0` (đúng các nhánh "Immediate tactics" hiện có).
- Trong `chooseGauntletMove`, sau khi có `root` (bước 2, sau lọc VCT phòng thủ): `root = filterByHints(root)` (qua toIdx/toCell), rồi **ổn định sắp xếp** `root` theo `w` giảm dần (giữ thứ tự cũ khi bằng nhau).
- Trong vòng PVS gốc (bước 3): giá trị dùng để so sánh là `v + hintBonus(q)`; `alpha` (cửa sổ tìm kiếm) không đổi — chỉ phần chọn `iterBest` cộng bonus. Cụ thể: giữ `v` cho search, tính `score = v + bonus` để so với `bestScore`.
- Khi `hints` rỗng/undefined: hành vi **giống hệt** hiện tại (test regression hiện có phải pass).

### 3.3 `src/game/bot.ts` (sửa)

- `BotOptions.hints?: GauntletHints`; chỉ truyền xuống `chooseGauntletMove` khi `level === 'gauntlet'`.

### 3.4 `src/tournament/match.ts` (sửa nhỏ)

- `SettleOpts.hints?: GauntletHints`. Nhánh bot move full-strength truyền `hints: opts?.hints` vào `chooseBotMove`. Không đổi gì khác (bot-vs-bot `fast` không nhận hints).

### 3.5 `src/server/gauntlet-book-store.ts` (mới)

```ts
export interface GauntletBookStore {
  /** Hint document for a position, or null. Must resolve quickly; callers race it against a timeout. */
  getBook(key: string, side: Side): Promise<BookDoc | null>
  /** Inserts the replay; returns false when `_id` already exists (already learned). */
  insertGame(rec: GameRecord): Promise<boolean>
  /** Applies deltas: `$inc` w/n/wins/losses per cell, upsert per (key, side). */
  applyDeltas(deltas: BookDelta[], now: number): Promise<void>
}
```

- `MemoryGauntletBookStore` (test, local không Mongo).
- `MongoGauntletBookStore(db)`: `gauntlet_book` với `_id = "<key>:<side>"`; `gauntlet_games` với TTL index trên `expiresAt` (createdAt + 90 ngày).
- `ensureIndexes` trong `src/server/db.ts` thêm TTL index cho `gauntlet_games`.

### 3.6 `src/server/gauntlet-learning.ts` (mới) — service nhỏ nối store với room

```ts
export interface GauntletLearning {
  /** Hints for the bot's upcoming move in `m`, or undefined (not a learnable match, timeout, error). */
  hintsFor(room: Room, m: Match): Promise<GauntletHints | undefined>
  /** Finds games that ended between `before` and `after` and learns from them. Never throws. */
  learnFromWrite(before: Room, after: Room, now: number): Promise<void>
}
export function createGauntletLearning(store: GauntletBookStore, log?: (msg: string, e?: unknown) => void): GauntletLearning
```

- Điều kiện "match học được": `resolveBotLevel(room) === 'gauntlet'`, đúng một trong `m.X`/`m.O` là bot.
- `hintsFor`: chỉ khi `m.status === 'playing'`, `m.botMoveDueAt !== null`, `m.moves.length ≥ 3` (3 nước đầu đã có book tĩnh). `Promise.race` với timeout `HINT_TIMEOUT_MS = 150`.
- `learnFromWrite`: với mỗi match học được mà `after.games.length === before.games.length + 1` **và** `after.moves.length ≥ before.moves.length` (ván chưa bị xoá bởi `startNextGame` trong cùng lần settle) **và** game mới có `endReason ∈ {'five_in_row','resign'}`:
  - `resign` chỉ học khi người thua (bot không bao giờ resign); với `five_in_row` winner là người hoặc bot đều học.
  - Tạo `GameRecord` (`gameIndex = after.games.length`), `insertGame`; nếu `false` (đã học) thì dừng.
  - `deltasFromGame(rec, isForcedPosition, (moves, side) => bookMove(moves, side) !== null)` → `applyDeltas`.
- Trường hợp bỏ sót chấp nhận được: người không poll quá `GAME_BREAK_MS` sau khi bot thắng → settle vừa kết thúc ván vừa mở ván mới, `moves` bị xoá, ván đó không được học.

### 3.7 `src/server/room-service.ts` (sửa)

- `RoomServiceDeps.learning?: GauntletLearning`.
- Trong `mutate`, sau `readPresence` và trước `settleRoom`: nếu có `caller` và `learning`, tìm match `caller.matchId` trong `loaded`; `hints = await learning.hintsFor(loaded, m)`; `opts = { fullBotMatchId, hints }`.
- Sau mỗi `write` thành công (cả nhánh thường và nhánh RoomError-nhưng-settled): `this.deps.afterWrite?.(loaded, saved, now)`. Thêm `RoomServiceDeps.afterWrite?: (before: Room, after: Room, now: number) => void`.
- `src/server/http.ts`: tạo `createGauntletLearning(new MongoGauntletBookStore(db))`, truyền `learning` và `afterWrite: (b, a, now) => after(() => learning.learnFromWrite(b, a, now))`.

## 4. Lỗi & giới hạn

- Mọi lỗi store: `console.warn` có prefix `[gauntlet-learn]`, bỏ qua.
- Không có Mongo (test/local dùng memory stores): `MemoryGauntletBookStore`, hoặc không truyền `learning` → hành vi cũ.
- Idempotent: `_id` của `gauntlet_games` chặn học hai lần khi retry/poll trùng.
- Chi phí mỗi request: tối đa 1 `findOne` theo `_id` (≤150 ms) cho request của match đang chờ bot Gauntlet; việc học chạy sau response.
- `learnFromWrite` chạy `isForcedPosition`/`bookMove` cho từng nước bot (xây `GauntletEngine` mỗi lần, cỡ ms) — ván ≤ 100 nước là vài chục ms.

## 5. Kiểm thử

- `tests/game/gauntlet-learn.test.ts`
  - 8 đối xứng của cùng một thế → cùng `key`; thế khác → key khác; `fromCanon(toCanon(c)) = c`.
  - Thế có ô ở x = −50: đối xứng đẩy ra ngoài bị bỏ qua nhưng vẫn ra key xác định.
  - `deltasFromGame`: bỏ nước book/forced; bot thắng → +1 mỗi nước; bot thua với k = 3 → −1.67, −2.33, −3.
  - `filterByHints`: loại khi `n ≥ 3 && w ≤ −3`; không loại nếu là nước duy nhất; `n = 2` không loại.
  - `hintBonus` clamp.
- `tests/game/bot-gauntlet.test.ts` (thêm)
  - `isForcedPosition` đúng cho 3 trường hợp + 1 trường hợp không forced.
  - Với hints cấm nước mà engine không hints sẽ chọn (thế midgame cố định, seed cố định) → bot chọn nước khác; với hints rỗng → kết quả giống cũ.
- `tests/server/gauntlet-learning.test.ts`
  - Memory store: ván người-vs-Gauntlet kết thúc `five_in_row` → `insertGame` 1 lần, book có delta; gọi lại cùng `before/after` → không học lần 2.
  - Prelude/Duel hoặc `turn_timeout` → không ghi gì.
  - `hintsFor` trả `undefined` khi store treo quá timeout (store giả `never resolve`).
- `tests/server/mongo-store.test.ts` (thêm 1 describe, skip nếu không có mongodb-memory-server): `MongoGauntletBookStore` upsert `$inc` đúng, `insertGame` trả `false` lần hai.
- `tests/tournament/*` hiện có phải pass nguyên vẹn.
