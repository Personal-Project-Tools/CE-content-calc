# Hướng Dẫn Sử Dụng Bộ Công Cụ Báo Cáo TikTok Content

Tài liệu này hướng dẫn đầy đủ quy trình vận hành hằng ngày cho người sử dụng cuối: từ thiết lập máy ban đầu, tự động tải báo cáo trên TikTok Seller Center, tổng hợp số liệu ra file Excel chung theo từng khách hàng/ngày (đối chiếu tự động từ Google Sheets nội bộ), đến dọn dẹp dữ liệu cũ để tiết kiệm bộ nhớ máy tính.

---

## Tổng Quan Quy Trình 3 Bước

| Bước | Công cụ sử dụng | Việc cần làm | Kết quả nhận được |
|---|---|---|---|
| **Bước 1** | Chrome Extension (**TikTok Content Calc**) | Chọn shop → chọn ngày/tháng → bấm tự động xuất báo cáo | Tối đa 4 file báo cáo gốc được tự động xếp vào `data\raw_file\<Ngày>\<Seller ID>\` |
| **Bước 2** | Terminal (`calculate_reports.py`) | Chạy lệnh tổng hợp số liệu & tự động đối chiếu khách hàng qua Google Sheets | Xuất ra 1 file Excel tổng tại `data\reports\tiktok_content_metrics.xlsx` (chia sheet theo ngày) |
| **Bước 3** | Terminal (`delete_reports.py`) | Xóa các thư mục ngày cũ không còn dùng trong `data\raw_file\` | Giải phóng dung lượng ổ cứng, giữ lại file kết quả tổng hợp |

---

## Phần 1: Thiết Lập Ban Đầu (Chỉ Làm 1 Lần Trên Máy Mới)

### 1.1. Tắt thông báo hỏi vị trí lưu file trên Chrome
Để quá trình xuất nhiều báo cáo liên tục không bị gián đoạn bởi cửa sổ hỏi chỗ lưu (`Save As`):
1. Mở trình duyệt Chrome, nhập vào thanh địa chỉ: `chrome://settings/downloads`
2. Tìm mục **Ask where to save each file before downloading** (*Hỏi vị trí lưu từng tệp trước khi tải xuống*).
3. **Tắt** công tắc này (gạt sang trái).

### 1.2. Liên kết thư mục tải xuống với thư mục `data\raw_file\`
Chạy file `scripts\setup-reports-junction.bat` (nhấp đúp trực tiếp hoặc chạy từ Terminal trong thư mục dự án).

* Tác dụng: Mọi báo cáo Chrome tải về thư mục `%USERPROFILE%\Downloads\CE-Reports` sẽ được dẫn thẳng vào `data\raw_file\` bên trong bộ công cụ.
* Nếu trước đó máy bạn đã có sẵn thư mục `Downloads\CE-Reports` chứa báo cáo cũ, file `.bat` này sẽ tự động chuyển toàn bộ dữ liệu sang `data\raw_file\` rồi tạo liên kết.

### 1.3. Cài đặt Chrome Extension
1. Mở Chrome, truy cập địa chỉ: `chrome://extensions`
2. Bật công tắc **Developer mode** (*Chế độ dành cho nhà phát triển*) ở góc trên bên phải.
3. Nhấn nút **Load unpacked** (*Tải tiện ích đã giải nén*).
4. Chọn thư mục **`extension`** nằm bên trong thư mục dự án (`...\CE-content-calc\extension`).
5. Nhấn biểu tượng mảnh ghép trên thanh công cụ Chrome và **Ghim (Pin)** tiện ích **TikTok Content Calc** để tiện thao tác.

> **Lưu ý:** Mỗi khi bộ công cụ có cập nhật mới, hãy vào lại `chrome://extensions` và nhấn biểu tượng **Reload (🔄)** tại thẻ của tiện ích này.

### 1.4. Cài đặt thư viện Python & Cấu hình kết nối Google Sheets (Bảo mật nội bộ)
Để đảm bảo bảo mật dữ liệu khách hàng (Data Privacy), thông tin đối chiếu `Clients <-> Seller ID` không lưu trực tiếp trên Git mà được đọc qua Google Service Account từ bảng Google Sheets nội bộ:

1. Cài đặt các thư viện cần thiết vào môi trường Python (`>= 3.11`):
   ```powershell
   pip install -r requirements.txt
   ```
2. Đặt file khóa JSON của Google Service Account vào `config\service.json` (file này đã được ẩn trong `.gitignore`). Đảm bảo Google Sheet nội bộ đã cấp quyền **Viewer** cho địa chỉ `client_email` trong `service.json`.
3. Tạo file `config\sheet.yaml` dựa trên bản mẫu [config/sheet.example.yaml](config/sheet.example.yaml) và điền `spreadsheet_id` thực tế:
   ```yaml
   sheet:
     credentials_file: "config/service.json"
     spreadsheet_id: "<YOUR_GOOGLE_SPREADSHEET_ID>"
     worksheet: "seller_scope"
     ranges:
       seller_full_match: "AV4:AV"  # Định dạng: <company> - <COUNTRY>.TTK.<SELLER_ID>
       seller_used_id: "AW4:AW"     # Định dạng: <COUNTRY>.TTK.<SELLER_ID>
       active_status: "I4:I"        # Trạng thái Active selling (TRUE / FALSE)
     filters:
       platform: "TTK"
       active_only: true            # Chỉ đối chiếu các shop có active_status == TRUE
   ```

---

## Phần 2: Bước 1 — Tải Báo Cáo Từ TikTok Shop

### Bước 1: Mở đúng Shop trên TikTok Seller Center
1. Đăng nhập tài khoản TikTok Seller Center trên Chrome và chọn đúng shop cần lấy báo cáo.
2. Nhấn vào biểu tượng Extension **TikTok Content Calc** trên thanh công cụ Chrome.
3. Kiểm tra khung thông tin Shop ở đầu popup:
   * Hiển thị đúng mã quốc gia (`SG`, `MY`, `PH`, `VN`, `TH`, `ID`...), tên shop và mã Seller ID dạng `<QUỐC_GIA>.TTK.<SELLER_ID>` (có nút **Copy** nếu cần sao chép nhanh).
   * Nếu màn hình báo **`No Seller ID Detected`**: nhấn nút **Open TikTok Seller Center** (hoặc chuyển sang tab Seller Center đang mở và chờ trang tải xong), sau đó nhấn **Refresh**.

### Bước 2: Chọn chế độ thời gian (`1. Task Mode & Period`)
Chọn một trong hai chế độ phù hợp với nhu cầu lấy số liệu:
* **`Single Day (Daily)`**: Tải báo cáo theo **1 ngày cụ thể**. Chọn đúng ngày ở ô chọn ngày bên dưới.
* **`Month (Monthly)`**: Tải báo cáo theo **cả 1 tháng** (tự động chọn trọn tháng trên lịch). Chọn đúng tháng/năm ở ô chọn tháng bên dưới.

### Bước 3: Chạy xuất báo cáo (`2. Export Reports`)
* Nhấn **`▶ Auto Export All 4 Reports`** *(khuyên dùng)* để công cụ tự động tải lần lượt đầy đủ 4 đầu mục báo cáo cho shop và thời gian đã chọn:
  1. `1_LIVE_Linked.xlsx` — Kênh `LIVE -> Details`, tab `Linked accounts`
  2. `2_LIVE_Affiliate.xlsx` — Kênh `LIVE -> Details`, tab `Affiliate accounts`
  3. `3_Video_Linked.xlsx` — Kênh `Video -> Details`, tab `Linked accounts`
  4. `4_Video_Affiliate.xlsx` — Kênh `Video -> Details`, tab `Affiliate accounts`
* Hoặc nếu chỉ cần tải bù một kênh riêng lẻ, bạn có thể nhấn **`Export LIVE Reports`** (chỉ tải 2 file LIVE) hoặc **`Export Video Reports`** (chỉ tải 2 file Video).

> **Lưu ý khi công cụ đang chạy:**
> * Bạn vẫn có thể chuyển sang làm việc trên tab khác của Chrome trong lúc chờ xuất báo cáo.
> * **Không đóng trình duyệt Chrome** và **không đăng xuất khỏi Seller Center** trước khi thanh trạng thái trên popup báo hoàn tất (`✓ Completed: ... exported!`).

### Bước 4: Kiểm tra dữ liệu đã tải
Các file tải về được tự động phân loại gọn gàng theo cấu trúc 3 tầng:
`data\raw_file\<YYYY-MM-DD hoặc YYYY-MM>\<SELLER_ID>\`

Ví dụ cho ngày `2026-11-18` của shop `MY.TTK.1000000000000000001`:

```text
data/
└── raw_file/
    └── 2026-11-18/
        └── MY.TTK.1000000000000000001/
            ├── 1_LIVE_Linked.xlsx
            ├── 2_LIVE_Affiliate.xlsx
            ├── 3_Video_Linked.xlsx
            └── 4_Video_Affiliate.xlsx
```

* Lặp lại thao tác chuyển Shop → kiểm tra ngày/tháng → nhấn **`▶ Auto Export All 4 Reports`** cho các shop tiếp theo.
* Nút **`Clear Data`** ở cuối popup dùng để xóa nhật ký hiển thị tạm trên giao diện Extension khi bắt đầu lượt mới (không xóa các file báo cáo đã tải về máy).

---

## Phần 3: Bước 2 — Tính Toán & Xuất File Excel Tổng Hợp

Sau khi đã tải xong báo cáo cho tất cả các shop và các ngày cần lấy số:

1. Mở **Terminal** (hoặc **PowerShell**) ngay tại thư mục gốc của dự án (`CE-content-calc`).
2. Chạy lệnh sau:

```powershell
python scripts\calculate_reports.py
```

*(Tùy chọn nâng cao)* Bạn có thể truyền thêm tham số tùy chỉnh đường dẫn cấu hình hoặc file `.xlsx` offline nếu cần:

```powershell
python scripts\calculate_reports.py --reports-dir <thư_mục_raw_file> --sheet-config config\sheet.yaml --output <file_kết_quả>
```

### Cấu trúc file Excel kết quả
File tổng hợp được lưu tại: **`data\reports\tiktok_content_metrics.xlsx`**

* **Cách chia sheet:** Mỗi ngày (`YYYY-MM-DD`) hoặc tháng (`YYYY-MM`) có trong `data\raw_file\` sẽ tạo thành **1 sheet riêng** (ví dụ `2026-11-16`, `2026-11-18`). Mỗi sheet chứa số liệu của **toàn bộ các Seller ID** đã tải trong ngày/tháng đó.
* **Ý nghĩa các cột trong mỗi sheet:**

| Tên cột | Mô tả chi tiết |
|---|---|
| **`Clients`** | Tên khách hàng (`<company>`) tách từ cột `seller_full_match` (`AV4:AV`) trên tab `seller_scope`. Nếu mã shop chưa có trên Google Sheet sẽ hiển thị `Unmapped`. |
| **`Seller ID`** | Tên Seller ID đầy đủ (`<company> - <QUỐC_GIA>.TTK.<SELLER_ID>`) lấy từ cột `AV4:AV` (nếu `Unmapped` sẽ giữ nguyên mã `<QUỐC_GIA>.TTK.<SELLER_ID>` của thư mục tải về). |
| **`Date`** | Ngày hoặc tháng tương ứng của báo cáo (`YYYY-MM-DD` hoặc `YYYY-MM`). |
| **`Content Type`** | Mỗi shop trong ngày có 2 dòng tách biệt: **`TikTok Content Live`** và **`TikTok Content Video`**. |
| **`revenue`** | Tổng doanh thu: dòng LIVE cộng cột `LIVE-attributed GMV` từ 2 file LIVE; dòng Video cộng cột `Video-attributed GMV` từ 2 file Video. |
| **`product_impression`** | Tổng `Product Impressions`: cộng từ 2 file thuộc cùng kênh (LIVE hoặc Video). |
| **`impression`** | Tổng lượt xem: dòng LIVE cộng cột `Views` từ 2 file LIVE; dòng Video cộng cột `Video views` (`Video Views` / `VV`) từ 2 file Video. |

---

## Phần 4: Bước 3 — Dọn Dẹp Báo Cáo Cũ Để Tiết Kiệm Bộ Nhớ

Sau thời gian dài sử dụng, thư mục `data\raw_file\` có thể chiếm nhiều dung lượng ổ cứng. Bạn có thể xóa nhanh toàn bộ dữ liệu báo cáo gốc theo một khoảng ngày cụ thể (định dạng `YYYY-MM-DD`, tính cả ngày bắt đầu và ngày kết thúc).

### 1. Xem trước các thư mục sẽ bị xóa (khuyên chạy trước để tránh xóa nhầm)
```powershell
python scripts\delete_reports.py --start '2026-11-15' --end '2026-11-18' --dry-run
```
Lệnh `--dry-run` **chỉ in ra danh sách các thư mục nằm trong khoảng ngày đã chọn** để bạn kiểm tra, hoàn toàn không xóa dữ liệu thật.

### 2. Thực hiện xóa chính thức
Sau khi xác nhận đúng các ngày cần bỏ, bỏ `--dry-run` và chạy:
```powershell
python scripts\delete_reports.py --start '2026-11-15' --end '2026-11-18'
```

> **Lưu ý:**
> * Lệnh này chỉ xóa các thư mục ngày `YYYY-MM-DD` nằm trong khoảng `--start` đến `--end` bên trong `data\raw_file\` (bao gồm toàn bộ thư mục Seller ID và file bên trong các ngày đó).
> * File Excel tổng hợp đã xuất trong `data\reports\` và các thư mục tháng `YYYY-MM` sẽ **không** bị xóa bởi lệnh này.

---

## Phần 5: Các Tình Huống Thường Gặp & Cách Xử Lý

### 1. Một số shop tải về ít hơn 4 file (chỉ có 1, 2 hoặc 3 file)
* **Nguyên nhân:** Trên giao diện TikTok Seller Center của ngày/tháng đó, một số tab (ví dụ `Affiliate accounts`) hiện thông báo **`No available data yet`** và nút Export bị khóa không bấm được.
* **Cách xử lý:** Đây là hành vi bình thường. Extension tự động bỏ qua tab bị thiếu dữ liệu để chuyển sang tải các tab còn lại mà không làm dừng quy trình. Khi chạy `calculate_reports.py`, phần tab/kênh không có file sẽ được tính là `0`.

### 2. Extension báo lỗi `Platform do not have Content Video report for YYYY-MM-DD` hoặc `Platform do not have Content LIVE report for YYYY-MM-DD`
* **Nguyên nhân:** Toàn bộ kênh Video hoặc LIVE cho ngày/tháng bạn vừa chọn chưa có báo cáo trên TikTok Seller Center (hoặc shop chưa phát sinh dữ liệu và nền tảng chưa hỗ trợ xuất).
* **Cách xử lý:** Kiểm tra lại ngày bạn chọn trên popup đã đúng chưa, hoặc mở trực tiếp trang đó trên Seller Center để kiểm tra xem nền tảng đã hiển thị dữ liệu hay chưa.

### 3. Extension hiện cảnh báo `⚠️ Please click Reload (🔄) on chrome://extensions to activate Reports/ folder routing.` hoặc file bị tải vào `Downloads` thay vì `data\raw_file\`
* **Cách xử lý:**
  1. Mở `chrome://extensions` và nhấn nút **Reload (🔄)** tại tiện ích **TikTok Content Calc**.
  2. Đảm bảo bạn đã chạy `scripts\setup-reports-junction.bat` ít nhất 1 lần.
  3. Kiểm tra lại mục `chrome://settings/downloads` đã tắt tùy chọn *Ask where to save each file before downloading* chưa.

### 4. Trong file Excel kết quả, cột `Clients` bị ghi là `Unmapped`
* **Nguyên nhân:** Mã Seller ID của shop vừa tải chưa có trên tab `seller_scope` của Google Sheet nội bộ (cột `AV4:AV` / `AW4:AW`).
* **Cách xử lý:** Bổ sung shop mới vào tab `seller_scope` trên Google Sheet, sau đó chạy lại lệnh `python scripts\calculate_reports.py`.

### 5. Popup luôn báo `No Seller ID Detected`
* **Cách xử lý:** Đảm bảo bạn đã đăng nhập đúng tài khoản TikTok Seller Center trên Chrome, nhấn **Open TikTok Seller Center** (hoặc chuyển sang tab của shop đó), chờ trang tải đầy đủ thông tin rồi nhấn **Refresh** trên popup.
