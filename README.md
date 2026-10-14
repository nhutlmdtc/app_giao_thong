# Cao Tốc Assist

Web app (PWA) chạy trên trình duyệt điện thoại, dùng camera sau để:

- **Đo khoảng cách đến xe phía trước** trong làn của mình (COCO-SSD / TensorFlow.js).
- **Nhận diện làn đường đang đi**: tô vùng làn, phân biệt vạch liền/đứt → làn trong cùng / giữa / ngoài cùng, đếm số làn khi chuyển làn, báo lệch làn.
- **Màn hình mô phỏng phối cảnh 3D kiểu Tesla** (không hiện ảnh thật): làn đường, xe mình, xe trước, các xe làn bên, mốc mét và vùng màu an toàn trên mặt đường. Nút 📷 để xem ảnh thật khi hiệu chỉnh.
- **Số chính là số giây cách xe trước** (khi có GPS), kèm số mét và khoảng cách an toàn; viền màn hình đổi xanh/vàng/đỏ.
- **Cảnh báo giọng nói tiếng Việt**: "Giữ khoảng cách", "Nguy hiểm, giảm tốc", "Xe phía trước giảm tốc", "Xe đang lệch trái/phải", "Làn N".
- **Tổng số làn và giới hạn tốc độ lấy từ bản đồ OpenStreetMap** theo vị trí GPS + hướng chạy (tách đúng nhánh cao tốc mỗi chiều). Tải dữ liệu bán kính 1,5 km, đi quá 1 km thì tải lại; mất mạng thì dùng cách dò vạch như cũ.
- **Tên đường** (OpenStreetMap, khớp theo hướng chạy) và **xã/phường · tỉnh** (Nominatim, tra lại mỗi 2 km).
- **Tự dò đường chân trời** từ điểm tụ của vạch kẻ, tự suy độ cao camera → đo khoảng cách theo mặt đường cho cả xe làn bên.
- **Bộ lọc Kalman** cho khoảng cách và tốc độ tiến lại gần xe trước → ít cảnh báo nhầm.
- **Nhắc vượt tốc độ** bằng giọng nói theo giới hạn trên bản đồ; **tự giảm tải khi pin < 20%** (không sạc).
- **Nhật ký chuyến đi** (📊): quãng đường, thời gian, tốc độ tối đa, thời gian bám xe < 1 giây, số lần cảnh báo nguy hiểm, thời gian vượt tốc độ. Lưu trong máy.
- **Tự chuyển giao diện ban đêm** theo độ sáng camera (chữ cam trên nền đen).
- Nhẹ hơn: camera 640×360, nhận dạng xe ~8 lần/giây, dò vạch ~20 lần/giây.
- **Cảnh báo âm thanh** khi khoảng cách nhỏ hơn mức an toàn theo tốc độ GPS (TT 38/2024/TT-BGTVT: 60 km/h → 35 m, ≤80 → 55 m, ≤100 → 70 m, ≤120 → 100 m) hoặc thời gian va chạm (TTC) < 4 s.

## Cách tính khoảng cách

1. Theo bề rộng xe: `D = f · W_thực / w_pixel` (ô tô 1,8 m; tải/khách 2,5 m), `f = (rộng ảnh/2) / tan(HFOV/2)`.
2. Theo bề rộng làn 3,75 m tại hàng chân xe (không phụ thuộc loại xe).
3. Khi cả hai hợp lý → trộn 60/40, làm mượt theo thời gian; nhân thêm hệ số hiệu chỉnh trong Cài đặt.

## Triển khai (GitHub Pages)

1. Repo → **Settings → Pages → Source: GitHub Actions**.
2. Push lên `main` hoặc nhánh hiện tại → workflow `.github/workflows/pages.yml` tự deploy.
   (Nếu deploy từ nhánh không phải mặc định bị chặn: Settings → Environments → `github-pages` → thêm nhánh vào *Deployment branches*.)
3. Mở `https://<user>.github.io/app_giao_thong/` bằng Chrome Android → menu ⋮ → **Thêm vào màn hình chính**.

Lần đầu cần mạng để tải TensorFlow.js + mô hình (~5 MB); sau đó được cache để dùng khi sóng yếu.

## Sử dụng

- Gắn điện thoại **nằm ngang, giữa kính lái**, camera nhìn thẳng. Cài đặt xong **trước khi chạy**.
- ⚙ Cài đặt: HFOV camera, hệ số hiệu chỉnh, đường chân trời, che nắp capo, bật debug để thấy điểm dò vạch.
- Hiệu chỉnh nhanh: đỗ xe sau một xe khác ở khoảng cách đo bằng thước (vd 10 m), chỉnh hệ số đến khi app hiển thị đúng.

> Chỉ mang tính tham khảo, không thay thế quan sát của tài xế. Không thao tác điện thoại khi đang lái xe.
