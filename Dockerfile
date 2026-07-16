# Sử dụng hình ảnh Node.js chính thức có sẵn Chrome cho Puppeteer
FROM ghcr.io/puppeteer/puppeteer:21.9.0

# Chuyển quyền sang root để cài đặt và cấu hình thư mục
USER root

# Thiết lập thư mục làm việc
WORKDIR /app

# Sao chép package.json và package-lock.json
COPY package*.json ./

# Cài đặt các thư viện Node.js sạch sẽ
RUN npm ci

# Sao chép toàn bộ mã nguồn vào container
COPY . .

# Tạo các thư mục lưu trữ tạm thời và cấp quyền đầy đủ
RUN mkdir -p downloads merge_file && chmod -R 777 downloads merge_file

# Khai báo cổng chạy ứng dụng
EXPOSE 3005

# Lệnh khởi chạy ứng dụng
CMD ["node", "server.js"]
