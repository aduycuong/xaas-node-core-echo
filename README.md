# Echo

Node để **kiểm tra**: trả lại input nhận được, và tùy chọn thử những gì workspace cấp cho node (variable, secret, connection, Google Sheet, folder file) mà không làm gì thật. Dùng khi dựng workflow mới, khi vừa tạo secret / connection và muốn chắc node đọc được, hoặc để thử retry.

Echo không bao giờ trả giá trị secret hay token: chỉ báo là đọc được.

## Input

Mọi ô đều tùy chọn; để trống hết thì node chỉ trả lại input.

| Ô | Ý nghĩa |
| --- | --- |
| `read_variable` | `true`: trả giá trị của variable chọn cho `ECHO_VARIABLE`, ở môi trường của run |
| `check_secret` | `true`: đọc secret chọn cho `ECHO_SECRET`; output chỉ ghi `"secret": true` |
| `check_connection` | `true`: đọc connection Google chọn cho `ECHO_CONNECTION`; output ghi đó là connection nào |
| `check_file` | `true`: đọc Google Sheet chọn cho `ECHO_FILE`; output ghi tên sheet |
| `write_file` | Đường dẫn trong folder `ECHO_FOLDER`, ví dụ `echo/test.json`: ghi input vào file đó (file trùng tên được ghi đè) |
| `read_file` | Đường dẫn trong folder `ECHO_FOLDER`: trả kích thước và 200 ký tự đầu |
| `list_files` | `true`: liệt kê file trong folder `ECHO_FOLDER` |
| `fail_with` | Một mã HTTP 400 – 599: node lỗi `SIMULATED_FAILURE` với mã đó, để thử retry |

## Resources (tab Resources)

Đều tùy chọn; chỉ cần chọn thứ bạn muốn thử.

| Tên | Loại |
| --- | --- |
| `ECHO_VARIABLE` | variable |
| `ECHO_SECRET` | secret |
| `ECHO_CONNECTION` | connection Google |
| `ECHO_FILE` | Google Sheet |
| `ECHO_FOLDER` | folder trong Files của workspace |

## Output

Luôn có:

```json
{ "echo": { "read_variable": true }, "attempt": 1, "env": "production" }
```

- `echo`: input như node nhận được, sau khi các `{{ … }}` đã được thay giá trị.
- `attempt`: lần thử đã cho ra kết quả (1 là lần đầu).
- `env`: môi trường của run.

Thêm theo ô đã bật: `variable`, `secret`, `connection` (`provider`, `name`, `external_id`), `file` (`id`, `kind`, `label`, `connection`), `written` (`path`, `workspace_path`, `size`, `replaced`), `read` (`path`, `size`, `text`), `listed` (danh sách đường dẫn).

## Ví dụ

### Variable có đúng giá trị ở môi trường này không

1. Tab Resources: chọn variable cho `ECHO_VARIABLE`.
2. `read_variable`: `true`

Output: `"variable": "<giá trị>"`, `"env": "production"`. Chạy ở môi trường khác thì thấy giá trị của môi trường đó.

### Secret mới tạo có dùng được không

1. Tab Resources: chọn secret cho `ECHO_SECRET`.
2. `check_secret`: `true`

Output `"secret": true` là đọc được. Lỗi `SECRET_NOT_SET`: secret chưa có giá trị ở môi trường của run.

### Connection Google còn hoạt động không

1. Tab Resources: chọn connection cho `ECHO_CONNECTION` (và một sheet cho `ECHO_FILE` nếu muốn).
2. `check_connection`: `true` (và `check_file`: `true`)

Output: `"connection": {"provider": "google", "name": "an@acme.com", …}`. Lỗi `CONNECTION_REVOKED`: kết nối lại ở trang Connections.

### Ghi rồi đọc file

1. Tab Resources: chọn một folder cho `ECHO_FOLDER`.
2. `write_file`: `echo/test.json`, `read_file`: `echo/test.json`, `list_files`: `true`

File mới hiện trong trang Files, ghi "Created by run #…".

### Thử retry

- `fail_with`: `503`

Mã 5xx (và 429) được thử lại tới 3 lần (chờ 2 s rồi 4 s), rồi run lỗi `SIMULATED_FAILURE`. Mã 4xx khác thì lỗi ngay, không thử lại.

## Lỗi

| Mã lỗi | Thử lại | Khi nào |
| --- | --- | --- |
| `SIMULATED_FAILURE` | Theo mã trong `fail_with` (5xx, 429: có) | Bật `fail_with` |
| `NOT_MAPPED` | Không | Bật một kiểm tra mà chưa chọn resource tương ứng ở tab Resources |
| `SECRET_NOT_SET`, `VARIABLE_NOT_SET` | Không | Secret / variable chưa có giá trị ở môi trường của run |
| `CONNECTION_REVOKED` | Không | Connection mất quyền: kết nối lại |
| `CONNECTION_EXPIRED` | Có | Token của connection vừa hết hạn |
