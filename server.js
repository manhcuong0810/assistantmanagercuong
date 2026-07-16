require('dotenv').config({ override: true });
const express = require('express');
const cors = require('cors');
const path = require('path');
const https = require('https');
const fs = require('fs');
const getFBInfo = require('@renpwn/fb-downloader');

// Helper to decode HTML Entities (e.g. &#xf9; -> ù)
const decodeHtmlEntities = (str) => {
    return (str || '').replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => {
        return String.fromCharCode(parseInt(hex, 16));
    }).replace(/&#([0-9]+);/g, (match, dec) => {
        return String.fromCharCode(parseInt(dec, 10));
    });
};

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files
app.use(express.static(path.join(__dirname)));

// Proxy endpoint to bypass CORS and resolve Tikwm API requests reliably
app.get('/api/download', (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) {
        return res.status(400).json({ code: -1, msg: "URL video không hợp lệ" });
    }
    
    const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(videoUrl)}`;
    
    https.get(apiUrl, (apiRes) => {
        let data = '';
        apiRes.on('data', (chunk) => {
            data += chunk;
        });
        
        apiRes.on('end', () => {
            try {
                const parsedData = JSON.parse(data);
                res.json(parsedData);
            } catch (e) {
                res.status(500).json({ code: -1, msg: "Không thể phân tích dữ liệu từ Tikwm API" });
            }
        });
    }).on('error', (err) => {
        console.error("Proxy error:", err);
        res.status(500).json({ code: -1, msg: "Lỗi kết nối tới máy chủ tải video" });
    });
});

// Proxy endpoint to resolve Facebook API requests
app.get('/api/download/facebook', async (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) {
        return res.status(400).json({ success: false, msg: "URL video Facebook không hợp lệ" });
    }

    try {
        const data = await getFBInfo(videoUrl);
        if (data && (data.hd || data.sd)) {
            res.json({
                success: true,
                data: {
                    id: Date.now().toString(),
                    title: decodeHtmlEntities(data.title) || "Video Facebook",
                    cover: data.thumbnail || "",
                    sd: data.sd || "",
                    hd: data.hd || ""
                }
            });
        } else {
            res.status(500).json({ success: false, msg: "Không thể lấy thông tin video Facebook từ API" });
        }
    } catch (e) {
        console.error("Facebook download proxy error:", e);
        res.status(500).json({ success: false, msg: `Lỗi phân tích video Facebook: ${e.message}` });
    }
});

// Thư mục downloads lưu trữ cục bộ
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
}

// Hàm hỗ trợ tự động chuyển hướng và ghi dữ liệu từ URL HTTPS
const followRedirectAndDownload = (fileUrl, writeStream, callback) => {
    https.get(fileUrl, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            // Theo dõi link chuyển hướng mới
            followRedirectAndDownload(response.headers.location, writeStream, callback);
        } else if (response.statusCode === 200) {
            response.pipe(writeStream);
            writeStream.on('finish', () => {
                writeStream.close();
                callback(null);
            });
        } else {
            callback(new Error(`HTTP status ${response.statusCode}`));
        }
    }).on('error', (err) => {
        callback(err);
    });
};

// Endpoint nhận thông tin và lưu video/nhạc về máy chủ cục bộ
app.post('/api/save', (req, res) => {
    const { url, type, title, id } = req.body;
    if (!url) {
        return res.status(400).json({ success: false, msg: "Thiếu đường dẫn (URL) để tải về" });
    }

    // Làm sạch tên file từ tiêu đề video
    const cleanTitle = (title || 'tiktok_video')
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // Bỏ dấu tiếng Việt
        .replace(/[^a-zA-Z0-9]/g, '_')                    // Bỏ ký tự đặc biệt
        .replace(/_+/g, '_')                              // Gộp các dấu gạch dưới liên tiếp
        .substring(0, 50);                                // Giới hạn độ dài tên file

    const ext = type === 'music' ? 'mp3' : 'mp4';
    const filename = `${id || Date.now()}_${cleanTitle}.${ext}`;
    const filePath = path.join(downloadsDir, filename);

    const fileStream = fs.createWriteStream(filePath);

    followRedirectAndDownload(url, fileStream, (err) => {
        if (err) {
            console.error("Lỗi khi tải tệp tin:", err);
            // Xóa file tạm nếu lỗi xảy ra giữa chừng
            fs.unlink(filePath, () => {});
            return res.status(500).json({ success: false, msg: `Không thể tải và lưu file: ${err.message}` });
        }

        res.json({
            success: true,
            filename: filename,
            filePath: filePath,
            msg: `Đã tải và lưu thành công tệp downloads/${filename}`
        });
    });
});

// Khởi tạo Telegram Bot
const { initBot } = require('./bot');
initBot();

app.listen(PORT, () => {
    console.log(`=================================================`);
    console.log(`🚀 TikTok Downloader running on http://localhost:${PORT}`);
    console.log(`=================================================`);
});
