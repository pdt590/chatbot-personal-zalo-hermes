# PROPOSAL — Rà soát, sửa lỗi và refactor hermes-zalo-plugin (v1.0.12)

Ngày: 2026-11-04 · Phạm vi: toàn bộ source (`server.js`, `zaloClient.js`, `markdownToZalo.js`, `permissions.js`, `paths.js`, `login.mjs`, `install.mjs`, `uninstall.mjs`, `bin/cli.mjs`, `hermes-plugin/adapter.py`, CI).

Các lỗi bên dưới đều đã được kiểm chứng: đọc code, chạy thử, hoặc đối chiếu với bridge đang chạy và profile `zalo8806`.

---

## 1. Lỗi nghiêm trọng (phải sửa)

### 1.1 Cài đặt phía bridge do wizard lưu không bao giờ tới được bridge
- **Hiện trạng:** `hermes gateway setup` lưu `ZALO_ALLOWED_ACTION_GROUPS`, `ZALO_ALLOW_DESTRUCTIVE`, `ZALO_ALLOWED_ACTIONS`, `ZALO_PLUGIN_TOKEN`, `ZALO_CLIMSG_RETENTION_DAYS`, `ZALO_INFO_*` vào `.env` của profile Hermes. Nhưng bridge chạy dưới systemd, launchd hoặc Scheduled Task, **không đọc file đó**, và unit service cũng không có `Environment=`.
- **Bằng chứng:** profile zalo8806 đặt `ZALO_ALLOWED_ACTION_GROUPS=all` và `ZALO_ALLOW_DESTRUCTIVE=true`. Thế nhưng `GET /policy` của bridge thật vẫn trả `groups=[read,send,interact]` và `allowDestructive=false`. Token cũng vậy: bridge **không bật xác thực** dù người dùng đã đặt token trong wizard.
- **Sửa:**
  - Bridge đọc thêm `~/.hermes-zalo/bridge.env` (thư mục data, theo `ZALO_DATA_DIR`) lúc khởi động. Biến môi trường thật vẫn được ưu tiên hơn file.
  - Wizard ghi các khoá phía bridge vào file này rồi đề nghị khởi động lại bridge.
  - CLI thêm lệnh `hermes-zalo-plugin restart`.

### 1.2 Lộ cookie phiên Zalo qua `/api/getCookie` với policy mặc định
- **Hiện trạng:** `permissions.js` xếp `getCookie` và `getContext` vào nhóm `read`, mà nhóm này **bật sẵn mặc định**. Agent, hoặc ai đó prompt-inject được agent, có thể gọi `/api/getCookie` để lấy cookie, imei và secretKey. Có những thứ đó là chiếm được tài khoản Zalo.
- **Sửa:** thêm tập `SENSITIVE_ACTIONS` (`getCookie`, `getContext`). Các action này bị chặn ở mọi nhóm, kể cả `all`. Chỉ chạy được khi liệt kê rõ trong `ZALO_ALLOWED_ACTIONS`. Bỏ chúng khỏi danh sách chọn "custom" của wizard.

### 1.3 `listener.stop()` sinh sự kiện `closed` giả, kích hoạt auto-relogin sai
- **Hiện trạng:** zca-js `stop()` gọi `ws.close(1000)`, và `onclose` vẫn phát `closed`. Vì vậy khi `relogin()` (`POST /relogin`) dừng listener cũ, handler `closed` của listener cũ vẫn chạy và gây ra chuỗi sau:
  - đặt `loggedIn=false` và dừng keepalive của **phiên mới**;
  - lên lịch auto-relogin bằng cookie **song song** với luồng QR đang chạy;
  - nếu server cho phép retry mã 1000, zca-js còn tự `start()` lại listener cũ, tạo kết nối "ma" dẫn tới lỗi DuplicateConnection.
- **Sửa:**
  - Đánh số thế hệ listener (`_listenerGen`). Mọi handler bỏ qua sự kiện của listener cũ, và nếu listener cũ tự kết nối lại thì dừng nó ngay.
  - Thêm khoá đăng nhập (`_loginPromise`) để `/relogin`, auto-relogin và đăng nhập lúc khởi động không chạy chồng lên nhau.

### 1.4 Agent bị dặn sai về markdown, trong khi bridge chuyển markdown sai
- `platform_hint` của adapter dặn "Zalo không render markdown, chỉ dùng plain text". Thực tế bridge **có** chuyển markdown sang style Zalo, và profile zalo8806 đã phải tự ghi đè hint này.
- `markdownToZalo` làm hỏng văn bản thường gặp (đã chạy thử):
  - `"* item one\n* item two"` cho ra `" item one\n item two"`: mất dấu bullet và in nghiêng xuyên qua nhiều dòng.
  - `"2 * 3 * 4 = 24"` cho ra `"2  3  4 = 24"`.
  - `"Run __init__.py and my__var__x"` cho ra `"Run init.py and myvarx"`.
  - `"#\nline"` làm mất ký tự xuống dòng.
  - Test `emoji` trong file đang **FAIL** mà không ai biết, vì CI không chạy test.
- **Sửa:** viết lại bộ phân tích theo quy tắc gần với CommonMark:
  - marker phải "bám chữ": `* ` hay ` * ` không còn bị hiểu là in nghiêng;
  - không áp style xuyên dòng;
  - `__x__` không áp khi nằm giữa từ;
  - bỏ qua phần nằm trong `` `code` `` và trong khối ```` ``` ````;
  - heading chỉ nhận `#` theo sau là dấu cách hoặc tab.
  
  Đồng thời sửa `platform_hint` thành "dùng Markdown cơ bản (đậm, nghiêng, gạch, heading); hệ thống tự chuyển sang định dạng Zalo".

### 1.5 Adapter in cảnh báo sai về `ZALO_ALLOW_ALL_USERS`
- Adapter ghi log "ZALO_ALLOW_ALL_USERS is deprecated and ignored". Thực tế Hermes gateway **có dùng** biến này qua `allow_all_env` để cho phép mọi người dùng. Thiếu nó, Hermes trả "I don't recognize you yet", và log bridge có ghi lại đúng tin này lúc 15:14.
- **Sửa:**
  - Bỏ cảnh báo sai.
  - Wizard tự đặt `ZALO_ALLOW_ALL_USERS=true` khi người dùng để trống danh sách user, đúng với câu hướng dẫn "để trống là cho phép tất cả". Khi có danh sách thì đặt `false`.

---

## 2. Lỗi mức trung bình

| # | File | Vấn đề | Cách sửa |
|---|------|--------|----------|
| 2.1 | adapter.py | `GET /policy` không gửi token, nên khi bật token sẽ nhận 401 và log policy ra `None` | Gửi `self._headers()` |
| 2.2 | adapter.py | Một event lỗi (handler ném exception) làm đứt SSE. Khi nối lại, bridge replay đúng event đó, nên lỗi lặp vô hạn (poison event) | Bắt lỗi từng event, ghi log, vẫn tăng `last_event_id` |
| 2.3 | adapter.py | Stream SSE kết thúc bình thường thì nối lại ngay, không nghỉ, dễ thành vòng lặp nóng | Nghỉ theo backoff cả khi stream kết thúc bình thường |
| 2.4 | adapter.py | `send_image(url)` đưa thẳng URL cho bridge như một đường dẫn file, luôn ra "file not found" | Tải URL về cache trước rồi mới gửi file |
| 2.5 | adapter.py | Loại thread (user/group) chỉ nhớ trong RAM. Sau khi restart, cron gửi tới home channel dạng `group:<id>` sẽ bị gửi như chat user | Nạp sẵn loại thread từ `ZALO_HOME_CHANNEL` |
| 2.6 | adapter.py | Từ khoá gọi bot `"bot"` khớp theo tiền tố, nên "both", "bottom" cũng bị coi là gọi bot. `_own_name` không bao giờ được gán | So khớp theo ranh giới từ. Bridge trả `ownName` trong `/health` (lấy từ `fetchAccountInfo` lúc login) |
| 2.7 | adapter.py | `get_chat_info` luôn trả `type: dm`, kể cả khi là group | Trả đúng loại đã nhớ |
| 2.8 | adapter.py | `connect()` gọi lại mà không đóng `ClientSession` cũ, gây rò session | Đóng session cũ trước |
| 2.9 | server.js | Middleware policy chạy **trước** xác thực: người chưa đăng nhập vẫn dò được action nào bị chặn (403 hay 401) | Gộp xác thực vào một middleware toàn cục chạy đầu tiên (miễn `/health`). So token bằng `timingSafeEqual` |
| 2.10 | server.js | `/send-attachment` và `/send-voice` gửi được **bất kỳ file nào**, kể cả `~/.hermes-zalo/credentials.json`, sang một chat Zalo | Từ chối đường dẫn nằm trong thư mục data của bridge |
| 2.11 | server.js | ID của sự kiện SSE bắt đầu lại từ 1 sau mỗi lần restart bridge, nên replay theo `Last-Event-ID` sai | Bắt đầu ID từ `Date.now()`: luôn tăng qua các lần restart và vẫn là số nguyên |
| 2.12 | login.mjs | Đăng nhập thành công khi bridge đang chạy nhưng đã đăng xuất, bridge vẫn không nạp credentials mới. Wizard dò lại thì vẫn thấy "logged out" | Sau khi login, gọi `POST /relogin {forceQR:false}` để bridge nạp cookie mới |
| 2.13 | login.mjs | Bước kiểm tra credentials cũ gọi `login()` không có `cookieOnly`. Cookie hỏng thì nhảy sang QR ngay trong bước kiểm tra, và thông báo bị lẫn lộn | Dùng `cookieOnly: true` |
| 2.14 | zaloClient.js | `_loadCliMsgCache()` đọc lại toàn bộ file JSONL ở **mỗi lần** relogin | Chỉ nạp một lần |
| 2.15 | zaloClient.js | Luồng QR lỗi (throw) thì không dừng countdown, và `qrState` bị kẹt | Thêm `try/finally` |
| 2.16 | zaloClient.js | `_infoCache` lớn lên không giới hạn (mỗi user hoặc group thêm một key) | Giới hạn 2000 mục, xoá mục cũ nhất |

## 3. Lỗi nhỏ / dọn dẹp

- `server.js`: bỏ import thừa (`markdownToZalo`, `__dirname`). `ROUTE_ACTION` của `GET /chat-info` với group cần map sang `getGroupInfo`. `limit` của `/stickers` bị NaN.
- `server.js`: lỗi `EADDRINUSE` khi `listen` hiện làm crash và in stack trace khó hiểu. Đổi thành thông báo rõ ràng rồi thoát.
- `zaloClient.js`: log cứng "(<=30d)" sửa theo đúng retention. Biểu thức `quote.content` thừa.
- CI: `node --check` thiếu `markdownToZalo.js`, và không chạy test nào. Sẽ thêm `npm test` (`node --test`).

## 4. Refactor

1. **`server.js`: bỏ khoảng 200 dòng lặp lại.**
   - Xác thực và policy gom vào middleware.
   - Thêm helper `route(handler, { login: true })` để gói `requireLogin`, `try/catch` và trả JSON lỗi.
   - Các route giữ nguyên URL, body và response.
2. **`permissions.js`: thêm hàm thuần `createPolicy(env)`.** Hàm này trả `{ isAllowed(method), describe() }` để test được độc lập với Express. Kiểm tra "action có tồn tại" bằng `Object.hasOwn`, nên các tên như `constructor` hay `toString` không bị nhận nhầm.
3. **`paths.js`: thêm `loadBridgeEnv()`**, dùng chung cho `server.js`, `login.mjs` và `bin/cli.mjs`.
4. **`markdownToZalo.js`: viết lại phần phân tích một lượt**, đánh dấu marker đã dùng để các rule không giẫm lên nhau. Chuyển test sang `test/markdownToZalo.test.mjs`.
5. **Thêm `test/`**, chạy bằng `node --test`, không cần đăng nhập Zalo:
   - markdown;
   - policy (gồm cả sensitive actions);
   - `loadBridgeEnv`;
   - đồng bộ `permissions.js` với `_ACTION_GROUP` trong adapter.

Không đổi: API HTTP công khai, định dạng sự kiện SSE, đường dẫn dữ liệu, tên service.

## 5. Ngoài phạm vi (chỉ ghi nhận)

- `check_requirements()` bắt buộc có env `ZALO_PLUGIN_URL`, nên nếu chỉ cấu hình `bridge_url` trong config.yaml thì không được nhận. Hook `check_fn` của Hermes không nhận tham số config, nên chưa sửa.
- ~~`stop` là alias của `uninstall`~~ → đã sửa: `stop` chỉ dừng service (giữ cài đặt), `restart` bật lại; xem `service.js`.
- 10 API mới của zca-js 2.2 (`createBankAccount`, `getListDevice`, …) chưa có trong `ACTION_GROUP`, nên đang bị chặn theo mặc định. Như vậy là an toàn và không cần sửa ngay.
- Vị trí style khi có emoji: code dùng chỉ số UTF-16 (🔥 tính là 2), còn test cũ kỳ vọng 4. Mình giữ UTF-16 vì khớp với cách JavaScript đánh chỉ số chuỗi. Điểm này cần thử thật trên Zalo để chắc chắn.

## 6. Kế hoạch kiểm thử

1. **Offline:** chạy `npm test` và `node --check` mọi file, và kiểm tra cú pháp adapter bằng Python (`py_compile`).
2. **Trên profile `zalo8806`:**
   - Sao lưu bản global đang cài (`~/.npm-global/lib/node_modules/hermes-zalo-plugin`) và `~/.hermes/profiles/zalo8806/plugins/zalo`.
   - Cài bản mới (`npm i -g .`), chép adapter vào profile, tạo `bridge.env` từ các khoá phía bridge của profile, rồi restart service bridge và gateway.
   - Kiểm tra:
     - `/health` có `ownName`;
     - `/policy` phản ánh đúng `.env` của profile (`all` + destructive);
     - `/api/getCookie` bị chặn (403);
     - gửi file trong thư mục data bị chặn;
     - SSE vẫn nối và nhận tin;
     - `POST /relogin {forceQR:false}` không sinh auto-relogin thừa và không làm session chết.
   - Có thể gửi một tin thử (kèm markdown và emoji) tới home channel, nhưng **chỉ khi được đồng ý**, vì đó là tin thật gửi tới người thật.
3. **Rollback:** chép lại bản sao lưu và restart service.

---

## 7. Kết quả thực hiện (2026-11-04)

Đã làm hết mục 1–4. Kết quả kiểm thử:

- **Offline:** `npm test` qua 30/30, unittest Python qua 7/7, `node --check` mọi file đều OK.
- **Smoke test** bridge mới ở cổng 18787, dùng thư mục data tạm:
  - `bridge.env` được nạp;
  - thiếu token thì nhận 401, kể cả `/policy` và `/api/*`;
  - `getCookie` bị chặn ngay cả khi policy là `all` + destructive;
  - `constructor` bị chặn;
  - cổng đã bị chiếm thì bridge thoát **trước khi** mở kết nối Zalo.
- **Trên bridge thật và profile zalo8806:**
  - Bridge đăng nhập lại bằng cookie. `/health` trả `ownName=Lily`.
  - `/policy` ra `read,send,interact`, 78/145 action. Trước đây là 80 vì còn `getCookie` và `getContext`.
  - `getCookie` và `getContext` trả 403.
  - Gửi file trong `~/.hermes-zalo`, kể cả qua đường dẫn có `..`, trả 403.
  - Restart gateway xong thì adapter mới kết nối (log `ownName=Lily`), SSE có 1 client.
  - Đã gửi 1 tin thử tới home channel (msgId 8451098529413).

### Lỗi phát hiện thêm khi triển khai

- **install.mjs ghi cứng đường dẫn Node có kèm số phiên bản vào service.** Unit systemd dùng `/snap/node/12157/bin/node`. Snap đã tự cập nhật và xoá bản 12157 từ 30/10, nên mọi lần restart, reboot hay crash sau đó đều thất bại với `status=203/EXEC`. Bridge cũ vẫn chạy được chỉ vì tiến trình chưa bao giờ khởi động lại.
- **Đã sửa:** thêm `stableNodeBin()` để dùng `/snap/<pkg>/current/...` hoặc `<prefix>/bin/node` thay cho đường dẫn Homebrew Cellar. Đã cài lại service, giờ `ExecStart=/snap/node/current/bin/node …`.

### Còn lại

- `~/.hermes/profiles/zalo8806/.env` vẫn ghi `ZALO_ALLOWED_ACTION_GROUPS=all` và `ZALO_ALLOW_DESTRUCTIVE=true`. Theo quyết định giữ nguyên policy, `bridge.env` ghi `read,send,interact`. Nếu chạy lại `hermes gateway setup`, wizard sẽ chép giá trị trong `.env` sang `bridge.env`, nên cần sửa `.env` trước nếu không muốn bật destructive.
- Code mới hiện được chép thẳng vào bản cài global (bản `1.0.12`, `node_modules` giữ nguyên với zca-js 2.2.0). Bản sao lưu nằm ở thư mục scratchpad của phiên này.
- Chưa bump version và chưa commit.
