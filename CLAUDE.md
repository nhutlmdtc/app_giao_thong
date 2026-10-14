# Quy tắc làm việc

- Khi người dùng yêu cầu tính năng/cải tiến: **phân tích ưu nhược điểm, trình bày phương án và chờ người dùng chốt trước khi viết code**. Không tự triển khai khi chưa được duyệt.
- Trả lời tiếng Việt, ngắn gọn, thực tế.

# Dự án

PWA "Cao Tốc Assist" (index.html, app.js, sw.js), host GitHub Pages qua `.github/workflows/pages.yml`.
- Nhận dạng xe: TensorFlow.js COCO-SSD; dò vạch kẻ: xử lý ảnh thuần JS; số làn/giới hạn tốc độ: OpenStreetMap (Overpass).
- Mô phỏng 3D: sim3d.js (Three.js, module ES, mô hình xe tự dựng); cars.js là bảng hãng/dòng xe. Bản vẽ Canvas 2D trong app.js là dự phòng.
- Cảnh báo giọng nói tiếng Việt; tên đường (Overpass) + xã/tỉnh (Nominatim); nhật ký chuyến đi lưu localStorage.
- Đổi file cache thì tăng phiên bản `CACHE` trong sw.js.
