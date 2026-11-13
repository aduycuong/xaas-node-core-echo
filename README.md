# Node `core.echo`

Node mẫu: trả lại đúng input nhận được. Từ 1.1.0 nó còn đọc được variable của workspace (`read_variables`) và kiểm tra secret đọc được hay không (`check_secrets`, không bao giờ trả giá trị), để thử env của run. Folder này vừa là node chạy thật để thử runner, vừa là **khuôn để tạo node mới**: chép cả folder, sửa `src/node.ts`, giữ nguyên phần còn lại.

## Một node là gì

Một node là một Cloudflare Worker riêng, chỉ runner gọi được (qua service binding). Node không có URL công khai, route hay cron trigger riêng. Mỗi **version** của node là một Worker riêng, để workflow cũ tiếp tục dùng version cũ.

| File | Nội dung | Khi tạo node mới |
| --- | --- | --- |
| `src/node.ts` | Manifest, schema input/output, hàm `execute`, hàm `checkHealth` | **Viết lại** |
| `src/index.ts` | Ba route của giao thức, validate, định dạng lỗi, log | Giữ nguyên |
| `src/protocol.ts` | Kiểu `NodeContext`, lớp `NodeError` | Giữ nguyên |
| `src/resources.ts` | Đọc secret, variable, connection đã map cho node qua `xaas-resource-broker` | Giữ nguyên |
| `src/node.test.ts` | Test gọi Worker giống cách runner gọi | Sửa theo node |
| `wrangler.jsonc` | Tên Worker, binding, secret | Sửa `name`, thêm binding nếu cần |

## Ba route của mọi node

| Route | Ai gọi | Trả về |
| --- | --- | --- |
| `POST /` | Runner, mỗi attempt một lần | `200 { "output": {…} }` hoặc lỗi |
| `GET /health` | Script deploy, qua runner (`GET /nodes/<tên Worker>/health`) | `200 { "ok": true, "key", "version" }`, hoặc `503` khi `ok` là `false` |
| `GET /.well-known/xaas-node.json` | Script deploy, để đăng ký node vào database | Manifest kèm JSON Schema của input và output |

### Request của `POST /`

```http
POST /
Content-Type: application/json
X-XaaS-Run-Id: <id của run>
X-XaaS-Node-Run-Id: <id của node run>
X-XaaS-Attempt: 1
Idempotency-Key: <id của node run, giống nhau ở mọi attempt>

{
  "input":   { "text": "hello" },
  "context": {},
  "run":     { "id": "…", "workspace": "<id của workspace>", "workflow": "sample-echo", "version": 1, "env": "production" },
  "node":    { "key": "core.echo", "version": "1.0.0", "label": "echo input" }
}
```

`input` là giá trị sau khi runner đã thay các template `{{ … }}` của workflow. Request không bao giờ mang giá trị secret hay variable: node tự đọc theo tên cho `run.workspace` và `run.env`.

### Response

| Tình huống | Status | Body | Runner xử lý |
| --- | --- | --- | --- |
| Thành công | `200` | `{ "output": {…} }` | Ghi output, chạy node kế tiếp |
| Input sai schema | `400` | `{ "error": { "code": "INVALID_INPUT", "message", "retryable": false } }` | Không retry, run thất bại |
| Lỗi nghiệp vụ (`NodeError`) | Do node chọn | `{ "error": { "code", "message", "retryable" } }` | Retry nếu `5xx`, `429` hoặc `retryable: true` |
| Lỗi không lường trước | `500` | `{ "error": { "code": "INTERNAL", …, "retryable": true } }` | Retry |

`index.ts` đã lo toàn bộ bảng này. Trong `execute` bạn chỉ cần trả về output hoặc `throw new NodeError(...)`.

## Viết `src/node.ts`

1. **`manifest`**: `key` (dạng `category.name`), `version`, `name`, `category`, `description`, `mode`, `timeout_ms`, `retry`. Runner dùng `timeout_ms` và `retry` qua bảng `node_versions`.
2. **`inputSchema` và `outputSchema`** (Zod): là nguồn duy nhất cho cả việc validate lẫn JSON Schema trong manifest. Thêm `.describe()` cho từng trường; mô tả đó sẽ hiện trên UI.
3. **`execute(input, ctx)`**: việc của node. `ctx` có `env` (binding và secret của Worker), `runId`, `nodeRunId`, `attempt`, `idempotencyKey`, `run`, và `getSecret(name)`, `getVariable(name)` để đọc secret, variable của workspace trong env của run.
4. **`checkHealth(env)`**: kiểm tra thứ node phụ thuộc (secret đã đặt chưa, tài nguyên có trả lời không). Giữ cho nhẹ và không bao giờ trả giá trị secret.

### Báo lỗi

```ts
// Không retry: dữ liệu sai, retry cũng vô ích.
throw new NodeError("CARD_DECLINED", "The card was declined.", { status: 402 });

// Retry: dịch vụ ngoài tạm thời quá tải.
throw new NodeError("UPSTREAM_BUSY", "The price API is busy.", { status: 503 });

// Status 4xx nhưng vẫn muốn retry.
throw new NodeError("LOCKED", "The record is locked.", { status: 409, retryable: true });
```

### Idempotency

Runner có thể gọi lại cùng một node run: khi node trả lỗi retry được, khi timeout, hoặc khi kết quả đã có nhưng runner chưa kịp lưu. `ctx.idempotencyKey` giống nhau ở mọi lần gọi của một node run.

- Node **không có side-effect** (như echo, hay một phép biến đổi dữ liệu): không cần làm gì.
- Node **có side-effect** (gửi email, trừ tiền, ghi dữ liệu): phải chặn việc làm hai lần. Chuyển `ctx.idempotencyKey` cho API ngoài nếu API đó hỗ trợ, hoặc lưu `key → kết quả` vào KV / D1 và trả lại kết quả cũ khi gặp key đã có.

### Secret

- Node **khai báo** những gì nó dùng trong `manifest.resources`: một danh sách, mỗi mục một tên, `kind` (`secret`, `variable`, `connection` + `provider`, `google.file` + `mime_types`, `google.folder`, `slack.channel`, `telegram.chat`, `facebook.page`), `required`, mô tả. Khai báo đúng item node làm việc (sheet nào, channel nào), không khai báo connection rồi thêm input id. Người dùng **chọn tường minh** từng mục ở tab Resources của inspector; mục `required` chưa chọn thì không publish được.
- Trong `execute`: `await ctx.getSecret("OPENAI_API_KEY")`, `await ctx.getVariable("LLM_MODEL")`, `await ctx.getResource("sheet")` (→ `{ kind, connection: { provider, account, credentials… }, item: { id, kind, label } }`) theo tên. File của workspace: `ctx.readFile(name, path?)`, `ctx.listFiles(name)`, `ctx.writeFile(name, path, body, { contentType, size? })` với resource `r2.file` / `r2.folder` (stream qua broker; tên file có thể đến từ input nhưng không ra ngoài folder đã chọn). Secret, variable lấy theo env của run. Chỉ đọc được những gì đã chọn cho node, đúng kind đã khai báo; khác đi bị từ chối (`NOT_MAPPED`).
- Node đọc qua `xaas-resource-broker` (binding `RESOURCE_BROKER` trong `wrangler.jsonc`) bằng token run trong header `X-XAAS-Resource-Token`. Node không có `DATABASE_URL` hay key giải mã. Token chỉ dùng được trong attempt đó.
- Lỗi: thiếu giá trị ở env → `SECRET_NOT_SET` / `VARIABLE_NOT_SET`; connection mất quyền → `CONNECTION_REVOKED` (không retry); token dịch vụ vừa hết hạn → `CONNECTION_EXPIRED` (retry).
- Secret của riêng node (API key của dịch vụ mà node bọc, không phụ thuộc workspace): `wrangler secret put <TÊN>`, khai báo kiểu trong `Env`, đọc qua `ctx.env`.
- Không ghi secret vào output, message lỗi hay log.

### Log

`index.ts` ghi một dòng JSON cho mỗi lần gọi, có `runId`, `nodeRunId`, `attempt`, kết quả và thời gian chạy. Nếu log thêm trong `execute`, kèm các id đó và không log secret hay toàn bộ input.

## Tạo node mới từ folder này

1. Chép folder thành `node-<category>-<name>`; xóa `node_modules` và `.wrangler` rồi chạy `npm install`.
2. Sửa `src/node.ts` và `src/node.test.ts`.
3. Sửa `name` trong `wrangler.jsonc` và `package.json`. Tên Worker là `node-<key đổi ký tự khác chữ, số thành gạch ngang>-v<version đổi chấm thành gạch ngang>`; ví dụ `scraper.marketplace_price` 1.2.0 là `node-scraper-marketplace-price-v1-2-0`. Một test có sẵn sẽ báo nếu tên không khớp manifest.
4. Chạy `npm test` và `npm run typecheck`.
5. Deploy và đăng ký node: từ repo app `xaas-workflows` chạy `npm run nodes:deploy` rồi chọn node (xem `../README.md`).

## Ra version mới

- Sửa lỗi mà workflow không nhận thấy khác biệt: deploy lại cùng Worker, không đổi version.
- Đổi schema input/output hoặc hành vi: tăng `version` trong manifest, đổi `name` trong `wrangler.jsonc`, deploy thành Worker mới. Worker của version cũ tiếp tục chạy cho tới khi không còn workflow nào dùng.

## Lệnh

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run dev
```

`npm run dev` chạy riêng node ở cổng 8790 để gọi thử bằng `curl`:

```bash
curl http://127.0.0.1:8790/health
```

```bash
curl http://127.0.0.1:8790/.well-known/xaas-node.json
```

```bash
curl -X POST http://127.0.0.1:8790/ -H "Content-Type: application/json" -d "{\"input\":{\"text\":\"hello\"}}"
```
