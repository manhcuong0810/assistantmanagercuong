const TelegramBot = require('node-telegram-bot-api');
const https = require('https');
const fs = require('fs');
const path = require('path');
const getFBInfo = require('@renpwn/fb-downloader');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Helper to decode HTML Entities (e.g. &#xf9; -> ù)
const decodeHtmlEntities = (str) => {
    return (str || '').replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => {
        return String.fromCharCode(parseInt(hex, 16));
    }).replace(/&#([0-9]+);/g, (match, dec) => {
        return String.fromCharCode(parseInt(dec, 10));
    });
};

// Helper to escape HTML special characters for Telegram messages
const escapeHtml = (text) => {
    return (text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
};

// Helper to download a file as Buffer
const downloadFileAsBuffer = (url) => {
    return new Promise((resolve, reject) => {
        https.get(url, { family: 4 }, (res) => { // Force IPv4 to bypass timeout
            if (res.statusCode === 301 || res.statusCode === 302) {
                return downloadFileAsBuffer(res.headers.location).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`Tải file thất bại: Mã lỗi ${res.statusCode}`));
            }
            const data = [];
            res.on('data', (chunk) => data.push(chunk));
            res.on('end', () => resolve(Buffer.concat(data)));
            res.on('error', reject);
        }).on('error', reject);
    });
};

// Helper to call DeepSeek Chat completions API
const callDeepSeek = async (systemPrompt, userPrompt, jsonMode = false) => {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
        throw new Error("Chưa cấu hình DEEPSEEK_API_KEY trong file .env");
    }

    const body = {
        model: "deepseek-chat",
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
        ]
    };

    if (jsonMode) {
        body.response_format = { type: "json_object" };
    }

    const response = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`DeepSeek API error (HTTP ${response.status}): ${errorText}`);
    }

    const resJson = await response.json();
    if (!resJson.choices || resJson.choices.length === 0) {
        throw new Error("DeepSeek API không trả về nội dung.");
    }
    return resJson.choices[0].message.content;
};

function initBot() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token || token === 'YOUR_TELEGRAM_BOT_TOKEN_HERE') {
        console.log(`=================================================`);
        console.log(`⚠️  [Telegram Bot] CHƯA CẤU HÌNH BOT TOKEN hoặc đang dùng token mặc định.`);
        console.log(`👉 Hãy điền mã token của bạn vào file .env ở thư mục gốc dự án để kích hoạt Bot Telegram!`);
        console.log(`=================================================`);
        return null;
    }

    const BotClass = TelegramBot.default || TelegramBot;
    const bot = new BotClass(token, { polling: true });
    console.log(`🤖 [Telegram Bot] Đang hoạt động ở chế độ Polling...`);

    let botInfo = null;
    bot.getMe().then(me => {
        botInfo = me;
        console.log(`🤖 Bot username: @${me.username}`);
    }).catch(err => console.error("Lỗi lấy thông tin Bot:", err));

    // Helper: tải tệp tin hỗ trợ redirect
    const followRedirectAndDownload = (fileUrl, writeStream, callback) => {
        https.get(fileUrl, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
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

    // Helper: Tải video Facebook qua Snapsave + Puppeteer (sử dụng khi thư viện getFBInfo lỗi hoặc bị chặn)
    const downloadFBVideoWithPuppeteer = async (fbUrl, destPath) => {
        const puppeteer = require(path.join(__dirname, 'node_modules', 'puppeteer-core'));
        const browser = await puppeteer.launch({
            headless: "new",
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36");
        
        try {
            await page.goto("https://snapsave.app/", { waitUntil: 'networkidle2', timeout: 30000 });
            await page.waitForSelector("#url", { timeout: 10000 });
            await page.type("#url", fbUrl);
            await page.click("#send");
            
            // Đợi bảng download xuất hiện
            await page.waitForSelector('.download-table, table, .table', { timeout: 25000 });
            
            // Lấy URL tải trực tiếp HD hoặc SD
            const directUrl = await page.evaluate(() => {
                const table = document.querySelector('.download-table, table, .table');
                if (!table) return null;
                const links = Array.from(table.querySelectorAll('a'));
                
                let hdLink = links.find(a => a.innerText.toLowerCase().includes('hd') || a.innerText.toLowerCase().includes('render'));
                if (hdLink) return hdLink.href;
                
                let anyLink = links.find(a => a.innerText.toLowerCase().includes('download'));
                if (anyLink) return anyLink.href;
                
                return links[0] ? links[0].href : null;
            });
            
            if (!directUrl || directUrl.includes('facebook-reels-download')) {
                throw new Error("Không tìm thấy đường dẫn tải video trực tiếp trên Snapsave");
            }
            
            // Tải file nhị phân bằng cách fetch trong context của trang để thừa hưởng cookies/session/IP
            const base64Data = await page.evaluate(async (url) => {
                const res = await fetch(url);
                if (!res.ok) throw new Error("Tải thất bại với mã lỗi HTTP " + res.status);
                const buffer = await res.arrayBuffer();
                const bytes = new Uint8Array(buffer);
                let binary = '';
                for (let i = 0; i < bytes.byteLength; i++) {
                    binary += String.fromCharCode(bytes[i]);
                }
                return window.btoa(binary);
            }, directUrl);
            
            fs.writeFileSync(destPath, Buffer.from(base64Data, 'base64'));
        } finally {
            await browser.close();
        }
    };

    // Helper: Tìm kiếm thông tin trên mạng qua DuckDuckGo HTML (không cần API key, tránh CAPTCHA)
    const searchDuckDuckGo = async (query) => {
        const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        try {
            const res = await fetch(searchUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
                }
            });
            if (!res.ok) throw new Error("HTTP Status " + res.status);
            const html = await res.text();
            
            const blocks = html.split('class="result results_links results_links_deep web-result');
            const items = [];
            
            const extractRealUrl = (ddgUrl) => {
                if (ddgUrl.includes('uddg=')) {
                    const parts = ddgUrl.split('uddg=');
                    if (parts.length > 1) {
                        const encoded = parts[1].split('&')[0];
                        return decodeURIComponent(encoded);
                    }
                }
                return ddgUrl;
            };

            for (let i = 1; i < blocks.length; i++) {
                const block = blocks[i];
                const titleMatch = block.match(/<a\s+[^>]*class="result__a"\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
                const snippetMatch = block.match(/<a\s+[^>]*class="result__snippet"\s+[^>]*>([\s\S]*?)<\/a>/i);
                
                if (titleMatch) {
                    const rawLink = titleMatch[1];
                    const realLink = extractRealUrl(rawLink);
                    const title = titleMatch[2].replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
                    
                    let snippet = '';
                    if (snippetMatch) {
                        snippet = snippetMatch[1].replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
                    }
                    
                    items.push({ title, link: realLink, snippet });
                    if (items.length >= 5) break; // Lấy tối đa 5 kết quả
                }
            }
            return items;
        } catch (e) {
            console.error("Lỗi khi tìm kiếm trên DuckDuckGo:", e.message);
            return [];
        }
    };



    // Helper: phân tích video qua Tikwm API
    const analyzeTikTokUrl = (videoUrl) => {
        return new Promise((resolve, reject) => {
            const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(videoUrl)}`;
            https.get(apiUrl, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        resolve(parsed);
                    } catch (e) {
                        reject(new Error("Lỗi phân tích dữ liệu JSON từ Tikwm API"));
                    }
                });
            }).on('error', (err) => reject(err));
        });
    };

    // Khi người dùng gửi lệnh /start
    bot.onText(/\/start/, (msg) => {
        const chatId = msg.chat.id;
        bot.sendMessage(
            chatId,
            `👋 <b>Xin chào ${escapeHtml(msg.from.first_name || 'bạn')}!</b>\n\n` +
            `Tôi là Bot đa năng hỗ trợ:\n` +
            `1. 🎬 Tải video TikTok & Facebook không dính logo (Gửi link trực tiếp).\n` +
            `2. 📸 Tải ảnh hàng loạt từ bài đăng Facebook (Gửi link bài đăng/ảnh trực tiếp).\n` +
            `3. 📄 Ghép các file thành PDF từ thư mục merge_file (Gửi lệnh <b>/merge</b> hoặc nhắn <b>ghép file</b>).\n` +
            `4. 📹 Ghép nhiều video thành 1 video (Gửi lệnh <b>/merge_video</b> hoặc nhắn <b>ghép video</b>).\n` +
            `5. 🧮 Giải toán lớp 3 (Gửi ảnh bài toán kèm chú thích "giải toán" hoặc "giải").\n` +
            `6. 📊 Ghi chép bán hàng lên Google Sheets (Nhắn tin chi tiết bán hàng như "Tiger 320k shopee hôm nay").\n\n` +
            `👉 Hãy gửi link video, tệp tin hoặc gõ lệnh để bắt đầu!`,
            { parse_mode: 'HTML' }
        );
    });

    // Lắng nghe tất cả các tin nhắn
    bot.on('message', async (msg) => {
        const chatId = msg.chat.id;
        let text = msg.text;
        if (text) {
            // Loại bỏ tag bot ở đầu tin nhắn (ví dụ trong chat nhóm: @tiktokdowloaderdevbot vẽ...)
            text = text.replace(/^\s*@tiktokdowloaderdevbot\s*/i, '').trim();
        }

        console.error(`📩 [Telegram Bot] Nhận tin nhắn từ Chat ID: ${chatId} (Type: ${msg.chat.type}).`);

        // Xử lý hành động XÓA dòng đã ghi lên Google Sheet bằng cách reply tin nhắn xác nhận
        if (msg.reply_to_message && text) {
            const replyMsg = msg.reply_to_message;
            const deleteKeywords = /^(xóa|xoa|delete|hủy|huy|xóa dòng này|xoa dong nay|xóa đi|xoa di)$/i;
            
            if (deleteKeywords.test(text.trim())) {
                console.error("DEBUG DELETE - Reply Msg Object:", JSON.stringify(replyMsg));
                const matchIndex = (replyMsg.text || replyMsg.caption || "").match(/(?:dòng thứ|dong thu|dòng|dong|STT)\s*(\d+)/i);
                
                if (matchIndex) {
                    const rowIndex = parseInt(matchIndex[1], 10);
                    const webAppUrl = process.env.GOOGLE_SHEETS_WEBAPP_URL;
                    
                    if (!webAppUrl) {
                        return bot.sendMessage(chatId, `⚠️ Chưa cấu hình GOOGLE_SHEETS_WEBAPP_URL trong file .env để thực hiện xóa.`, {
                            reply_to_message_id: msg.message_id
                        });
                    }
 
                    let statusMsg = await bot.sendMessage(chatId, `⏳ Đang thực hiện xóa dòng thứ ${rowIndex} trên Google Sheet...`, {
                        reply_to_message_id: msg.message_id
                    });
 
                    try {
                        const response = await fetch(webAppUrl, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
                                action: "delete",
                                row_index: rowIndex
                            })
                        });
 
                        if (!response.ok) {
                            throw new Error(`Google Apps Script trả về HTTP ${response.status}`);
                        }
 
                        const resJson = await response.json();
                        if (resJson.success) {
                            await bot.editMessageText(`🗑️ <b>Đã xóa thành công dòng có STT ${rowIndex} khỏi Google Sheet!</b>`, {
                                chat_id: chatId,
                                message_id: statusMsg.message_id,
                                parse_mode: 'HTML'
                            });
                        } else {
                            throw new Error(resJson.error || "Không thể xóa dòng này trên Google Sheet.");
                        }
                    } catch (err) {
                        console.error("Lỗi khi thực hiện xóa dòng:", err);
                        await bot.editMessageText(`❌ <b>Lỗi khi xóa dòng:</b> ${err.message}`, {
                            chat_id: chatId,
                            message_id: statusMsg.message_id,
                            parse_mode: 'HTML'
                        }).catch(() => {});
                    }
                } else {
                    await bot.sendMessage(chatId, `⚠️ Không thể tìm thấy số dòng (STT) cần xóa từ tin nhắn được trả lời.\nHãy chắc chắn bạn đang reply đúng tin nhắn thông báo lưu thành công của Bot.`, {
                        reply_to_message_id: msg.message_id
                    }).catch(() => {});
                }
                return; // Luôn dừng xử lý để tránh chém gió/tâm sự khi gõ lệnh xóa
            }
        }

        // Xử lý tải file (tài liệu, ảnh hoặc video) được gửi trực tiếp vào chat nhóm hoặc chat riêng
        if (msg.document || msg.photo || msg.video) {
            const caption = msg.caption || '';
            const isMathProblem = /giải|giai|toán|toan|\/giai|\/solve|\/giaitoan/i.test(caption);
            const isDrawEditRequest = /sửa|sua|vẽ lại|ve lai|thay đổi|thay doi|chuyển sang|chuyen sang|đổi|doi|vẽ|ve|edit|draw/i.test(caption);

            if (isDrawEditRequest) {
                let fileId = null;
                if (msg.photo) {
                    fileId = msg.photo[msg.photo.length - 1].file_id;
                } else if (msg.document) {
                    fileId = msg.document.file_id;
                }

                if (fileId) {
                    const geminiApiKey = process.env.GEMINI_API_KEY;
                    if (!geminiApiKey) {
                        return bot.sendMessage(chatId, `⚠️ <b>Chưa cấu hình Gemini API Key!</b>\n\nTính năng phân tích hình ảnh và sửa ảnh yêu cầu <code>GEMINI_API_KEY</code>. Vui lòng cấu hình key này trong file <code>.env</code>.`, {
                            reply_to_message_id: msg.message_id,
                            parse_mode: 'HTML'
                        });
                    }

                    let statusMsg = await bot.sendMessage(chatId, `⏳ Đang đọc hiểu hình ảnh và lập kế hoạch chỉnh sửa...`, {
                        reply_to_message_id: msg.message_id
                    });

                    try {
                        const fileInfo = await bot.getFile(fileId);
                        const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
                        const buffer = await downloadFileAsBuffer(fileUrl);

                        const genAI = new GoogleGenerativeAI(geminiApiKey);
                        const model = genAI.getGenerativeModel({ model: 'gemini-flash-lite-latest' });

                        const systemInstruction = 
                            `You are an expert AI image prompting assistant.
Analyze the user's image and their edit request.
Create a highly detailed, professional English prompt for a text-to-image generator (like Pollinations/Stable Diffusion) that reflects the original image's style, composition, lighting, and subjects, but incorporates the user's requested changes.
Ensure the output contains ONLY the final English prompt string, and nothing else (no conversational filler, no code blocks, no explanations).`;

                        const userPrompt = `Yêu cầu chỉnh sửa của người dùng: "${caption}"`;

                        const result = await model.generateContent([
                            { text: systemInstruction },
                            {
                                inlineData: {
                                    data: buffer.toString("base64"),
                                    mimeType: "image/jpeg"
                                }
                            },
                            { text: userPrompt }
                        ]);

                        const newPrompt = result.response.text().trim();
                        console.error(`[Image Edit Prompt Created]: "${newPrompt}"`);

                        await bot.editMessageText(`🎨 Đang vẽ lại hình ảnh mới dựa trên mô tả đã chỉnh sửa...`, {
                            chat_id: chatId,
                            message_id: statusMsg.message_id
                        });

                        const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(newPrompt)}?width=1024&height=1024&nologo=true&private=true`;

                        await bot.sendChatAction(chatId, 'upload_photo').catch(() => {});

                        await bot.sendPhoto(chatId, imageUrl, {
                            caption: `🎨 <b>Ảnh đã chỉnh sửa theo yêu cầu:</b>\n- Yêu cầu: "${escapeHtml(caption)}"\n📢 Nguồn: Pollinations AI`,
                            parse_mode: 'HTML',
                            reply_to_message_id: msg.message_id
                        });

                        await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});

                    } catch (err) {
                        console.error("Lỗi sửa ảnh:", err.message);
                        await bot.editMessageText(`❌ Sửa ảnh thất bại: ${err.message}`, {
                            chat_id: chatId,
                            message_id: statusMsg.message_id
                        }).catch(() => {});
                    }
                    return;
                }
            }

            if (isMathProblem) {
                // Xử lý giải toán lớp 3
                let fileId;
                if (msg.photo) {
                    fileId = msg.photo[msg.photo.length - 1].file_id;
                } else if (msg.document) {
                    fileId = msg.document.file_id;
                }

                if (fileId) {
                    const geminiApiKey = process.env.GEMINI_API_KEY;
                    if (!geminiApiKey) {
                        return bot.sendMessage(chatId, `⚠️ <b>Chưa cấu hình Gemini API Key!</b>\n\nĐể sử dụng tính năng giải toán, bạn hãy mở file <code>.env</code> ở thư mục gốc của dự án và thêm dòng sau:\n<code>GEMINI_API_KEY=mã_api_key_của_bạn</code>\n\nSau đó khởi động lại bot để áp dụng nhé!`, {
                            reply_to_message_id: msg.message_id,
                            parse_mode: 'HTML'
                        });
                    }

                    let statusMsg;
                    try {
                        statusMsg = await bot.sendMessage(chatId, `⏳ Đang đọc đề bài và tìm lời giải toán lớp 3 thích hợp...`, {
                            reply_to_message_id: msg.message_id
                        });

                        if (!geminiApiKey) {
                            return bot.editMessageText(`❌ <b>Lỗi giải toán:</b> Tính năng giải toán qua ảnh chụp bắt buộc phải có <code>GEMINI_API_KEY</code> vì DeepSeek hiện tại chỉ hỗ trợ văn bản. Vui lòng cấu hình lại <code>GEMINI_API_KEY</code> trong file <code>.env</code> để sử dụng tính năng này.`, {
                                chat_id: chatId,
                                message_id: statusMsg.message_id,
                                parse_mode: 'HTML'
                            });
                        }

                        const fileInfo = await bot.getFile(fileId);
                        const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;

                        // Tải file về dạng Buffer
                        const buffer = await downloadFileAsBuffer(fileUrl);

                        // Gọi Gemini API giải toán
                        const genAI = new GoogleGenerativeAI(geminiApiKey);
                        const model = genAI.getGenerativeModel({ model: 'gemini-flash-lite-latest' });

                        const fileToGenerativePart = (buf, mimeType) => ({
                            inlineData: {
                                data: buf.toString("base64"),
                                mimeType
                            },
                        });

                        let mimeType = 'image/jpeg';
                        if (msg.document && msg.document.mime_type) {
                            mimeType = msg.document.mime_type;
                        }

                        const imagePart = fileToGenerativePart(buffer, mimeType);
                        
                        const prompt = "Bạn là một giáo viên dạy Toán cấp tiểu học xuất sắc (đặc biệt là lớp 3). " +
                            "Hãy đọc hình ảnh bài toán này và giải chi tiết từng bước theo phương pháp giảng dạy trực quan, " +
                            "dễ hiểu nhất cho học sinh lớp 3. Trình bày các bước rõ ràng (Tóm tắt đề bài nếu cần, Lời giải, Phép tính, Đáp số). " +
                            "Giọng điệu dễ thương, khuyến khích học tập. Trả lời hoàn toàn bằng tiếng Việt.";

                        const result = await model.generateContent([prompt, imagePart]);
                        let solutionText = result.response.text();
                        
                        // Định dạng lại in đậm Markdown từ ** sang * để tránh lỗi hiển thị trên Telegram
                        solutionText = solutionText.replace(/\*\*/g, '*');

                        // Cập nhật tin nhắn với lời giải
                        try {
                            await bot.editMessageText(`📝 *LỜI GIẢI CHI TIẾT (LỚP 3):*\n\n${solutionText}`, {
                                chat_id: chatId,
                                message_id: statusMsg.message_id,
                                parse_mode: 'Markdown'
                            });
                        } catch (markdownError) {
                            console.warn("Lỗi parse Markdown, gửi lại dạng thường:", markdownError.message);
                            await bot.editMessageText(`📝 LỜI GIẢI CHI TIẾT (LỚP 3):\n\n${solutionText}`, {
                                chat_id: chatId,
                                message_id: statusMsg.message_id
                            }).catch(() => {});
                        }
                    } catch (err) {
                        console.error("Lỗi khi giải toán bằng Gemini:", err);
                        if (statusMsg) {
                            bot.editMessageText(`❌ Lỗi khi giải toán: ${err.message}`, {
                                chat_id: chatId,
                                message_id: statusMsg.message_id
                            }).catch(() => {});
                        } else {
                            bot.sendMessage(chatId, `❌ Lỗi khi giải toán: ${err.message}`, {
                                reply_to_message_id: msg.message_id
                            }).catch(() => {});
                        }
                    }
                }
                return;
            }

            let fileId;
            let fileName;

            if (msg.document) {
                fileId = msg.document.file_id;
                fileName = msg.document.file_name;
            } else if (msg.photo) {
                const photo = msg.photo[msg.photo.length - 1];
                fileId = photo.file_id;
                fileName = `photo_${Date.now()}.jpg`;
            } else if (msg.video) {
                fileId = msg.video.file_id;
                fileName = msg.video.file_name || `video_${Date.now()}.mp4`;
            }

            if (fileId && fileName) {
                let downloadStatusMsg;
                try {
                    downloadStatusMsg = await bot.sendMessage(chatId, `⏳ Đang tải file "${fileName}" về thư mục merge_file...`, {
                        reply_to_message_id: msg.message_id
                    });

                    const fileInfo = await bot.getFile(fileId);
                    const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;

                    const chromeDir = path.join(__dirname, 'merge_file');
                    if (!fs.existsSync(chromeDir)) {
                        fs.mkdirSync(chromeDir, { recursive: true });
                    }

                    // Kiểm tra xem người dùng có chỉ định số thứ tự qua caption (chú thích) không
                    let nextIndex = null;
                    const caption = msg.caption;
                    if (caption) {
                        const cleanCaption = caption.trim();
                        if (/^\d+$/.test(cleanCaption)) {
                            nextIndex = parseInt(cleanCaption, 10);
                        }
                    }

                    // Nếu không chỉ định qua caption, tự động tính số thứ tự tiếp theo dựa trên các file hiện có
                    if (nextIndex === null) {
                        nextIndex = 1;
                        try {
                            const existingFiles = fs.readdirSync(chromeDir);
                            let maxIndex = 0;
                            for (const file of existingFiles) {
                                const match = file.match(/^(\d{5})_/);
                                if (match) {
                                    const idx = parseInt(match[1], 10);
                                    if (idx > maxIndex) {
                                        maxIndex = idx;
                                    }
                                }
                            }
                            nextIndex = maxIndex + 1;
                        } catch (e) {
                            console.error("Lỗi khi tính toán số thứ tự file:", e);
                        }
                    }

                    const prefix = String(nextIndex).padStart(5, '0');
                    const fileNameWithPrefix = `${prefix}_${fileName}`;
                    const filePath = path.join(chromeDir, fileNameWithPrefix);
                    const fileStream = fs.createWriteStream(filePath);

                    await new Promise((resolve, reject) => {
                        followRedirectAndDownload(fileUrl, fileStream, (err) => {
                            if (err) reject(err);
                            else resolve();
                        });
                    });

                    await bot.editMessageText(`📥 Đã nhận và lưu file vào thư mục merge_file thành công:\n📂 <code>${fileName}</code>`, {
                        chat_id: chatId,
                        message_id: downloadStatusMsg.message_id,
                        parse_mode: 'HTML'
                    });
                } catch (err) {
                    console.error("Lỗi tải file từ Telegram:", err);
                    if (downloadStatusMsg) {
                        bot.editMessageText(`❌ Lỗi khi lưu file: ${err.message}`, {
                            chat_id: chatId,
                            message_id: downloadStatusMsg.message_id
                        }).catch(() => {});
                    } else {
                        bot.sendMessage(chatId, `❌ Lỗi khi lưu file "${fileName}": ${err.message}`, {
                            reply_to_message_id: msg.message_id
                        }).catch(() => {});
                    }
                }
            }
            return;
        }

        if (!text) return;

        // Xử lý lệnh giải toán bằng văn bản (cho ảnh đã gửi trước đó mà không có caption)
        const mathSolveRegex = /^\s*(\/giai|\/solve|giải toán|giai toan|solve|giải bài này|giai bai nay|giải)\s*$/i;
        if (mathSolveRegex.test(text)) {
            const chromeDir = path.join(__dirname, 'merge_file');
            if (fs.existsSync(chromeDir)) {
                try {
                    const files = fs.readdirSync(chromeDir);
                    const imageFiles = files.filter(f => {
                        const ext = path.extname(f).toLowerCase();
                        return ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'].includes(ext) && /^\d{5}_/.test(f);
                    });

                    if (imageFiles.length > 0) {
                        // Sắp xếp để tìm ảnh được tải lên gần đây nhất (index cao nhất)
                        imageFiles.sort();
                        const lastImageFile = imageFiles[imageFiles.length - 1];
                        const lastImagePath = path.join(chromeDir, lastImageFile);

                        const geminiApiKey = process.env.GEMINI_API_KEY;
                        if (!geminiApiKey) {
                            return bot.sendMessage(chatId, `⚠️ <b>Chưa cấu hình Gemini API Key!</b>\n\nĐể sử dụng tính năng giải toán, bạn hãy mở file <code>.env</code> ở thư mục gốc của dự án và thêm dòng sau:\n<code>GEMINI_API_KEY=mã_api_key_của_bạn</code>\n\nSau đó khởi động lại bot để áp dụng nhé!`, {
                                reply_to_message_id: msg.message_id,
                                parse_mode: 'HTML'
                            });
                        }

                        statusMsg = await bot.sendMessage(chatId, `⏳ Đang đọc đề bài và tìm lời giải toán lớp 3 thích hợp...`, {
                            reply_to_message_id: msg.message_id
                        });

                        if (!geminiApiKey) {
                            return bot.editMessageText(`❌ <b>Lỗi giải toán:</b> Tính năng giải toán qua ảnh chụp bắt buộc phải có <code>GEMINI_API_KEY</code> vì DeepSeek hiện tại chỉ hỗ trợ văn bản. Vui lòng cấu hình lại <code>GEMINI_API_KEY</code> trong file <code>.env</code> để sử dụng tính năng này.`, {
                                chat_id: chatId,
                                message_id: statusMsg.message_id,
                                parse_mode: 'HTML'
                            });
                        }

                        // Đọc file ảnh dưới dạng Buffer
                        const buffer = fs.readFileSync(lastImagePath);

                        // Xóa ảnh ra khỏi thư mục merge_file ngay lập tức để không bị ghép nhầm vào file PDF sau này
                        try {
                            fs.unlinkSync(lastImagePath);
                        } catch (e) {
                            console.error("Lỗi khi xóa ảnh khỏi thư mục tạm:", e);
                        }

                        // Gọi Gemini API giải toán
                        const genAI = new GoogleGenerativeAI(geminiApiKey);
                        const model = genAI.getGenerativeModel({ model: 'gemini-flash-lite-latest' });

                        const fileToGenerativePart = (buf, mimeType) => ({
                            inlineData: {
                                data: buf.toString("base64"),
                                mimeType
                            },
                        });

                        const ext = path.extname(lastImageFile).toLowerCase();
                        let mimeType = 'image/jpeg';
                        if (ext === '.png') mimeType = 'image/png';
                        else if (ext === '.webp') mimeType = 'image/webp';
                        else if (ext === '.gif') mimeType = 'image/gif';
                        else if (ext === '.bmp') mimeType = 'image/bmp';

                        const imagePart = fileToGenerativePart(buffer, mimeType);
                        
                        const prompt = "Bạn là một giáo viên dạy Toán cấp tiểu học xuất sắc (đặc biệt là lớp 3). " +
                            "Hãy đọc hình ảnh bài toán này và giải chi tiết từng bước theo phương pháp giảng dạy trực quan, " +
                            "dễ hiểu nhất cho học sinh lớp 3. Trình bày các bước rõ ràng (Tóm tắt đề bài nếu cần, Lời giải, Phép tính, Đáp số). " +
                            "Giọng điệu dễ thương, khuyến khích học tập. Trả lời hoàn toàn bằng tiếng Việt.";

                        const result = await model.generateContent([prompt, imagePart]);
                        let solutionText = result.response.text();
                        
                        solutionText = solutionText.replace(/\*\*/g, '*');

                        try {
                            await bot.editMessageText(`📝 *LỜI GIẢI CHI TIẾT (LỚP 3):*\n\n${solutionText}`, {
                                chat_id: chatId,
                                message_id: statusMsg.message_id,
                                parse_mode: 'Markdown'
                            });
                        } catch (markdownError) {
                            console.warn("Lỗi parse Markdown, gửi lại dạng thường:", markdownError.message);
                            await bot.editMessageText(`📝 LỜI GIẢI CHI TIẾT (LỚP 3):\n\n${solutionText}`, {
                                chat_id: chatId,
                                message_id: statusMsg.message_id
                            }).catch(() => {});
                        }
                        return;
                    } else {
                        return bot.sendMessage(chatId, `⚠️ Tôi không thấy bức ảnh đề bài nào trong danh sách chờ. Bạn hãy gửi ảnh bài toán trước, sau đó gõ "giải toán" nhé!`, {
                            reply_to_message_id: msg.message_id
                        });
                    }
                } catch (e) {
                    console.error("Lỗi khi giải toán từ ảnh tạm:", e);
                    return bot.sendMessage(chatId, `❌ Lỗi khi xử lý giải toán: ${e.message}`, {
                        reply_to_message_id: msg.message_id
                    });
                }
            } else {
                return bot.sendMessage(chatId, `⚠️ Tôi không thấy bức ảnh đề bài nào cả. Bạn hãy gửi ảnh trước nhé!`, {
                    reply_to_message_id: msg.message_id
                });
            }
        }

        const mergeRegex = /^\s*(\/merge|ghép file|ghep file)\s*$/i;
        const isMergeCmd = mergeRegex.test(text);

        if (isMergeCmd) {
            let statusMsg;
            try {
                statusMsg = await bot.sendMessage(chatId, "⏳ Đang quét thư mục `merge_file` và ghép các file thành PDF...", {
                        reply_to_message_id: msg.message_id
                    });
                
                const { exec } = require('child_process');
                const scriptPath = path.join(__dirname, 'merge_documents.py');
                exec(`python3 "${scriptPath}"`, async (err, stdout, stderr) => {
                    if (err) {
                        console.error("Lỗi chạy script ghép PDF:", err);
                        return bot.editMessageText(`❌ Lỗi thực thi: ${err.message}`, {
                            chat_id: chatId,
                            message_id: statusMsg.message_id
                        }).catch(() => {});
                    }
                    
                    try {
                        const result = JSON.parse(stdout.trim());
                        if (result.success) {
                            const pdfPath = result.merged_file;
                            const filesMerged = result.files_merged.map(f => f.replace(/^\d{5}_/, '')).join('\n- ');
                            
                            await bot.editMessageText(`✅ Ghép thành công ${result.files_merged.length} file:\n- ${filesMerged}\n\n📤 Đang gửi file PDF kết quả...`, {
                                chat_id: chatId,
                                message_id: statusMsg.message_id
                            });
                            
                            await bot.sendDocument(chatId, pdfPath, {
                                caption: "📄 File PDF đã được ghép hoàn chỉnh từ thư mục merge_file."
                            }, {
                                reply_to_message_id: msg.message_id
                            });
                            
                            // Xóa tin nhắn trạng thái sau khi gửi xong
                            await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});

                            // Xóa các file đầu vào trong thư mục merge_file sau khi ghép thành công để sạch thư mục cho lần sau
                            for (const filename of result.files_merged) {
                                const filePath = path.join(__dirname, "merge_file", filename);
                                try {
                                    if (fs.existsSync(filePath)) {
                                        fs.unlinkSync(filePath);
                                    }
                                } catch (e) {
                                    console.error(`Không thể xóa file đầu vào ${filename}:`, e);
                                }
                            }
                        } else {
                            await bot.editMessageText(`❌ Thất bại: ${result.error}`, {
                                chat_id: chatId,
                                message_id: statusMsg.message_id
                            });
                        }
                    } catch (e) {
                        console.error("Lỗi xử lý kết quả ghép PDF:", e);
                        await bot.editMessageText(`❌ Lỗi xử lý kết quả: ${e.message}`, {
                            chat_id: chatId,
                            message_id: statusMsg.message_id
                        });
                    }
                });
            } catch (err) {
                console.error("Lỗi lệnh ghép PDF:", err.message);
                bot.sendMessage(chatId, `❌ Lỗi: ${err.message}`).catch(() => {});
            }
            return;
        }

        const mergeVideoRegex = /^\s*(\/merge_video|ghép video|ghep video)\s*$/i;
        const isMergeVideoCmd = mergeVideoRegex.test(text);

        if (isMergeVideoCmd) {
            let statusMsg;
            try {
                statusMsg = await bot.sendMessage(chatId, "⏳ Đang quét thư mục `merge_file`, chuẩn hóa định dạng và ghép các video...", {
                    reply_to_message_id: msg.message_id
                });
                
                const { exec } = require('child_process');
                const scriptPath = path.join(__dirname, 'merge_videos.py');
                exec(`python3 "${scriptPath}"`, async (err, stdout, stderr) => {
                    if (err) {
                        console.error("Lỗi chạy script ghép Video:", err);
                        return bot.editMessageText(`❌ Lỗi thực thi: ${err.message}`, {
                            chat_id: chatId,
                            message_id: statusMsg.message_id
                        }).catch(() => {});
                    }
                    
                    try {
                        const result = JSON.parse(stdout.trim());
                        if (result.success) {
                            const videoPath = result.merged_file;
                            const filesMerged = result.files_merged.map(f => f.replace(/^\d{5}_/, '')).join('\n- ');
                            
                            await bot.editMessageText(`✅ Ghép thành công ${result.files_merged.length} video:\n- ${filesMerged}\n\n📤 Đang gửi video kết quả (có thể mất một lúc)...`, {
                                chat_id: chatId,
                                message_id: statusMsg.message_id
                            });
                            
                            await bot.sendVideo(chatId, videoPath, {
                                caption: "📹 Video đã được ghép hoàn chỉnh từ thư mục merge_file."
                            }, {
                                reply_to_message_id: msg.message_id
                            });
                            
                            // Xóa tin nhắn trạng thái sau khi gửi xong
                            await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});

                            // Xóa các file video đầu vào sau khi ghép thành công
                            for (const filename of result.files_merged) {
                                const filePath = path.join(__dirname, "merge_file", filename);
                                try {
                                    if (fs.existsSync(filePath)) {
                                        fs.unlinkSync(filePath);
                                    }
                                } catch (e) {
                                    console.error(`Không thể xóa file video đầu vào ${filename}:`, e);
                                }
                            }
                        } else {
                            await bot.editMessageText(`❌ Thất bại: ${result.error}`, {
                                chat_id: chatId,
                                message_id: statusMsg.message_id
                            });
                        }
                    } catch (e) {
                        console.error("Lỗi xử lý kết quả ghép Video:", e);
                        await bot.editMessageText(`❌ Lỗi xử lý kết quả: ${e.message}`, {
                            chat_id: chatId,
                            message_id: statusMsg.message_id
                        });
                    }
                });
            } catch (err) {
                console.error("Lỗi lệnh ghép Video:", err.message);
                bot.sendMessage(chatId, `❌ Lỗi: ${err.message}`).catch(() => {});
            }
            return;
        }

        // Lệnh vẽ ảnh bằng AI (sử dụng Pollinations AI miễn phí không cần key)
        const drawCmdRegex = /^\s*(\/draw|\/ve|\/image|\/paint|vẽ|ve)\s+(.+)$/i;
        const drawMatch = text.match(drawCmdRegex);

        if (drawMatch) {
            const promptText = drawMatch[2].trim();
            let statusMsg;
            try {
                statusMsg = await bot.sendMessage(chatId, "⏳ Đang vẽ hình ảnh bằng trí tuệ nhân tạo, vui lòng đợi giây lát...", {
                    reply_to_message_id: msg.message_id
                });

                await bot.sendChatAction(chatId, 'upload_photo').catch(() => {});

                // Link API tạo ảnh Pollinations AI
                const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(promptText)}?width=1024&height=1024&nologo=true&private=true`;

                await bot.sendPhoto(chatId, imageUrl, {
                    caption: `🎨 <b>Ảnh vẽ theo yêu cầu:</b> "${escapeHtml(promptText)}"\n📢 Nguồn: Pollinations AI (Miễn phí)`,
                    parse_mode: 'HTML',
                    reply_to_message_id: msg.message_id
                });

                await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
            } catch (err) {
                console.error("Lỗi vẽ ảnh:", err.message);
                if (statusMsg) {
                    await bot.editMessageText(`❌ Vẽ ảnh thất bại: ${err.message}`, {
                        chat_id: chatId,
                        message_id: statusMsg.message_id
                    }).catch(() => {});
                } else {
                    bot.sendMessage(chatId, `❌ Vẽ ảnh thất bại: ${err.message}`).catch(() => {});
                }
            }
            return;
        }

        // Tìm link tiktok và facebook trong tin nhắn
        const tiktokRegex = /(https?:\/\/(?:vt|vm|www)\.tiktok\.com\/[^\s\n]+)/i;
        const match = text.match(tiktokRegex);

        const facebookRegex = /(https?:\/\/(?:[a-zA-Z0-9.-]+\.)?facebook\.com\/[^\s\n]+|https?:\/\/fb\.watch\/[^\s\n]+)/i;
        const fbMatch = text.match(facebookRegex);
        let statusMsg;

        if (match) {
            const videoUrl = match[0];
            try {
                statusMsg = await bot.sendMessage(chatId, "⏳ Đang kết nối máy chủ và phân tích link video...", {
                reply_to_message_id: msg.message_id
            });

            // 1. Phân tích video
            const result = await analyzeTikTokUrl(videoUrl);

            if (result.code !== 0 || !result.data) {
                throw new Error(result.msg || "Không thể lấy thông tin video. Hãy chắc chắn link hợp lệ.");
            }

            const videoData = result.data;
            const playUrl = videoData.play || videoData.hdplay || videoData.wmplay;

            if (!playUrl) {
                throw new Error("Không tìm thấy đường dẫn tải video không dính logo.");
            }

            await bot.editMessageText("📥 Đang tải video về máy chủ cục bộ...", {
                chat_id: chatId,
                message_id: statusMsg.message_id
            });

            // 2. Chuẩn bị file và lưu cục bộ
            const cleanTitle = (videoData.title || 'tiktok_video')
                .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
                .replace(/[^a-zA-Z0-9]/g, '_')
                .replace(/_+/g, '_')
                .substring(0, 50);

            const downloadsDir = path.join(__dirname, 'downloads');
            if (!fs.existsSync(downloadsDir)) {
                fs.mkdirSync(downloadsDir, { recursive: true });
            }

            const filename = `${videoData.id || Date.now()}_${cleanTitle}.mp4`;
            const filePath = path.join(downloadsDir, filename);

            const fileStream = fs.createWriteStream(filePath);

            await new Promise((resolve, reject) => {
                followRedirectAndDownload(playUrl, fileStream, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });

            await bot.editMessageText("📤 Đang gửi video qua Telegram cho bạn...", {
                chat_id: chatId,
                message_id: statusMsg.message_id
            });

            // 3. Gửi video lên Telegram
            const title = escapeHtml(videoData.title || 'Video TikTok');
            const author = escapeHtml(videoData.author?.unique_id || 'user');

            await bot.sendVideo(chatId, filePath, {
                caption: `🎬 <b>${title}</b>\n\n👤 Kênh: @${author}`,
                parse_mode: 'HTML',
                reply_to_message_id: msg.message_id
            });

            // Xóa tin nhắn trạng thái
            await bot.deleteMessage(chatId, statusMsg.message_id);

        } catch (err) {
            console.error("Lỗi Telegram Bot:", err.message);
            if (statusMsg) {
                bot.editMessageText(`❌ Đã xảy ra lỗi: ${err.message}`, {
                    chat_id: chatId,
                    message_id: statusMsg.message_id
                }).catch(() => { });
            } else {
                bot.sendMessage(chatId, `❌ Đã xảy ra lỗi: ${err.message}`).catch(() => { });
            }
        }
        } else if (fbMatch) {
            const fbUrl = fbMatch[0];
            const isPhoto = /photo|posts|permalink|albums|media/i.test(fbUrl);

            if (isPhoto) {
                try {
                    statusMsg = await bot.sendMessage(chatId, "⏳ Đang kết nối máy chủ và cào các ảnh từ bài đăng Facebook...", {
                        reply_to_message_id: msg.message_id
                    });

                    const { exec } = require('child_process');
                    const escapedUrl = fbUrl.replace(/(["\s'$`\\])/g, '\\$1');
                    const scriptPath = path.join(__dirname, 'scrape_fb_photos.js');
                    exec(`node "${scriptPath}" "${escapedUrl}"`, async (err, stdout, stderr) => {
                        if (err) {
                            console.error("Lỗi chạy script cào ảnh FB:", err);
                            return bot.editMessageText(`❌ Lỗi thực thi: ${err.message}`, {
                                chat_id: chatId,
                                message_id: statusMsg.message_id
                            }).catch(() => {});
                        }

                        try {
                            const result = JSON.parse(stdout.trim());
                            if (result.success) {
                                await bot.editMessageText(`✅ Đã tải thành công ${result.files_downloaded.length} ảnh về thư mục merge_file!\n\n📤 Đang gửi ảnh trực tiếp cho bạn...`, {
                                    chat_id: chatId,
                                    message_id: statusMsg.message_id
                                });

                                const mediaGroup = result.files_downloaded.map(filename => {
                                    const filePath = path.join(__dirname, "merge_file", filename);
                                    return {
                                        type: 'photo',
                                        media: filePath
                                    };
                                });

                                for (let i = 0; i < mediaGroup.length; i += 10) {
                                    const chunk = mediaGroup.slice(i, i + 10);
                                    await bot.sendMediaGroup(chatId, chunk, {
                                        reply_to_message_id: msg.message_id
                                    }).catch(async (mediaGrpErr) => {
                                        console.error("Lỗi gửi sendMediaGroup, thử gửi lẻ từng file:", mediaGrpErr.message);
                                        for (const item of chunk) {
                                            await bot.sendPhoto(chatId, item.media).catch(() => {});
                                        }
                                    });
                                }

                                await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});

                            } else {
                                await bot.editMessageText(`❌ Thất bại: ${result.error}`, {
                                    chat_id: chatId,
                                    message_id: statusMsg.message_id
                                });
                            }
                        } catch (e) {
                            console.error("Lỗi xử lý kết quả cào ảnh:", e);
                            await bot.editMessageText(`❌ Lỗi xử lý kết quả: ${e.message}`, {
                                chat_id: chatId,
                                message_id: statusMsg.message_id
                            });
                        }
                    });

                } catch (err) {
                    console.error("Lỗi tải ảnh Facebook:", err.message);
                    if (statusMsg) {
                        bot.editMessageText(`❌ Đã xảy ra lỗi khi tải ảnh Facebook: ${err.message}`, {
                            chat_id: chatId,
                            message_id: statusMsg.message_id
                        }).catch(() => {});
                    } else {
                        bot.sendMessage(chatId, `❌ Đã xảy ra lỗi khi tải ảnh Facebook: ${err.message}`).catch(() => {});
                    }
                }
            } else {
                try {
                    statusMsg = await bot.sendMessage(chatId, "⏳ Đang kết nối máy chủ và phân tích link Facebook...", {
                        reply_to_message_id: msg.message_id
                    });

                    // 1. Phân tích video Facebook
                    let playUrl;
                    let titleText = 'Video Facebook';
                    let fbData;
                    
                    try {
                        fbData = await getFBInfo(fbUrl);
                        if (fbData && (fbData.hd || fbData.sd)) {
                            playUrl = fbData.hd || fbData.sd;
                            titleText = fbData.title || 'Video Facebook';
                        }
                    } catch (e) {
                        console.log("Thử getFBInfo thất bại, chuyển sang cào Puppeteer:", e.message);
                    }

                    const downloadsDir = path.join(__dirname, 'downloads');
                    if (!fs.existsSync(downloadsDir)) {
                        fs.mkdirSync(downloadsDir, { recursive: true });
                    }

                    const cleanTitle = titleText
                        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
                        .replace(/[^a-zA-Z0-9]/g, '_')
                        .replace(/_+/g, '_')
                        .substring(0, 50);

                    const filename = `fb_${Date.now()}_${cleanTitle}.mp4`;
                    const filePath = path.join(downloadsDir, filename);

                    if (playUrl) {
                        await bot.editMessageText("📥 Đang tải video Facebook về máy chủ cục bộ...", {
                            chat_id: chatId,
                            message_id: statusMsg.message_id
                        });

                        const fileStream = fs.createWriteStream(filePath);

                        await new Promise((resolve, reject) => {
                            followRedirectAndDownload(playUrl, fileStream, (err) => {
                                if (err) reject(err);
                                else resolve();
                            });
                        });
                    } else {
                        await bot.editMessageText("📥 Đang cào và tải video Facebook qua snapsave.app (Puppeteer)...", {
                            chat_id: chatId,
                            message_id: statusMsg.message_id
                        });

                        await downloadFBVideoWithPuppeteer(fbUrl, filePath);
                    }

                    await bot.editMessageText("📤 Đang gửi video qua Telegram cho bạn...", {
                        chat_id: chatId,
                        message_id: statusMsg.message_id
                    });

                    // 3. Gửi video lên Telegram
                    const title = escapeHtml(decodeHtmlEntities(titleText));

                    await bot.sendVideo(chatId, filePath, {
                        caption: `🎬 <b>${title}</b>\n\n📢 Tải từ: Facebook`,
                        parse_mode: 'HTML',
                        reply_to_message_id: msg.message_id
                    });

                    // Xóa tin nhắn trạng thái
                    await bot.deleteMessage(chatId, statusMsg.message_id);

                } catch (err) {
                    console.error("Lỗi tải Facebook:", err.message);
                    if (statusMsg) {
                        bot.editMessageText(`❌ Đã xảy ra lỗi khi tải Facebook: ${err.message}`, {
                            chat_id: chatId,
                            message_id: statusMsg.message_id
                        }).catch(() => {});
                    } else {
                        bot.sendMessage(chatId, `❌ Đã xảy ra lỗi khi tải Facebook: ${err.message}`).catch(() => {});
                    }
                }
            }
        }

        // 4. Ghi chép dữ liệu bán bia lên Google Sheets hoặc Chém gió/Tâm sự (nếu được cấu hình)
        const webAppUrl = process.env.GOOGLE_SHEETS_WEBAPP_URL;
        const geminiApiKey = process.env.GEMINI_API_KEY;
        const deepseekApiKey = process.env.DEEPSEEK_API_KEY;

        if ((deepseekApiKey || geminiApiKey) && text && !text.startsWith('/') && !match && !fbMatch) {
            const systemKeywords = /^(ghép file|ghep file|ghép video|ghep video|giải toán|giai toan|giải|giai|solve)$/i;
            if (!systemKeywords.test(text.trim())) {
                try {
                    const todayStr = new Date().toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
                    const systemPrompt = `Bạn là trợ lý ảo đa năng tích hợp bộ lọc ghi nhận bán bia vào Google Sheets.
Nhiệm vụ của bạn là phân tích tin nhắn của người dùng và trả về kết quả JSON tương ứng:

Quy tắc phân tích nghiêm ngặt:
- Tuyệt đối KHÔNG tự suy diễn hoặc tự tiện gán giá trị mặc định cho Loại bia hoặc Giá bán. 
- Tin nhắn chỉ được coi là giao dịch bán bia nếu có đề cập rõ ràng tên loại bia cụ thể (như Tiger, Heineken, 333, Bia Hà Nội, Bia Sài Gòn, Larue, Trúc Bạch, Budweiser...) và số tiền bán.
- Nếu tin nhắn có từ ngữ nghe tương tự nhưng không phải tên bia (ví dụ: "gửi từng cái", "từng cái thôi"), TUYỆT ĐỐI không được nhận diện thành tên bia "Tiger".
- Nếu tin nhắn không liên quan đến mua bán bia (như chém gió, chào hỏi, ra lệnh hệ thống, hoặc lời nói chuyện bình thường), bạn PHẢI xếp vào nhóm chém gió/tâm sự và trả về "chat_response".

Các trường hợp cụ thể:
1. Nếu tin nhắn mô tả một giao dịch bán bia thực sự (có loại bia và giá bán rõ ràng):
   Trả về cấu trúc JSON sau:
   {
     "beer_type": "Tên loại bia (Tiger, Heineken, v.v.)",
     "quantity": 1, // Số lượng bán được (số nguyên, mặc định là 1 nếu không chỉ rõ)
     "import_price": 280000, // Giá nhập (số nguyên tổng số tiền nhập nếu có thông tin, nếu không có để null)
     "price": 320000, // Giá bán tổng cộng (số nguyên, bắt buộc phải có)
     "date": "Định dạng DD/MM/YYYY. Ngày bán bia. Nếu không nói ngày nào, dùng ngày hiện tại được cấp là: ${todayStr}"
   }

2. Nếu tin nhắn nhắc đến loại bia thật sự nhưng KHÔNG có thông tin về giá bán hoặc không thể xác định được số tiền bán (ví dụ: "mới bán tiger"):
   Trả về cấu trúc JSON sau:
   {
     "error": "missing_price",
     "beer_type": "Tên loại bia nhận diện được"
   }

3. Nếu tin nhắn là lời nói chuyện thông thường, chém gió, chào hỏi, tâm sự hoặc hỏi đáp các chủ đề khác (bao gồm cả các yêu cầu tìm kiếm tin tức trên mạng, viết bài đăng Facebook, biên tập nội dung, giải đáp thắc mắc...):
   Hãy đóng vai một người bạn thông minh, thân thiện, hài hước và trả lời bằng tiếng Việt tự nhiên nhất.
   Đặc biệt: Nếu ở cuối tin nhắn của người dùng có đính kèm phần [DỮ LIỆU TÌM KIẾM TRỰC TUYẾN THỜI GIAN THỰC DUCKDUCKGO], bạn BẮT BUỘC phải đọc và sử dụng thông tin trong đó để trả lời câu hỏi, tổng hợp tin tức, hoặc biên tập thành bài đăng Facebook hoàn chỉnh, hấp dẫn theo đúng yêu cầu của người dùng.
   Lưu ý: Lời phản hồi phải là một chuỗi JSON hợp lệ. Nếu có sử dụng dấu ngoặc kép bên trong lời phản hồi, hãy escape nó bằng dấu gạch chéo ngược (ví dụ: \\\"...) để tránh lỗi JSON.
   Trả về cấu trúc JSON sau:
   {
     "chat_response": "Nội dung bài viết Facebook đã biên tập, tin tức tổng hợp hoặc câu trả lời chém gió/tâm sự của bạn"
   }`;

                    let parsed;
                    let resultText = "";
                    
                    // Kiểm tra và thực hiện tìm kiếm tin tức trên mạng
                    const isSearchQuery = /tìm kiếm|tim kiem|tìm tin tức|tim tin tuc|tra mạng|tra mang|search|lên mạng|len mang|tin tức về|tin tuc ve|google/i.test(text);
                    let searchContext = "";
                    if (isSearchQuery) {
                        await bot.sendChatAction(chatId, 'find_location').catch(() => {});
                        const searchQuery = text.replace(/@\w+/g, '').replace(/^(hãy|hay|hãy tìm|tìm kiếm|tìm|tra mạng|search|google|lên mạng tìm|lên mạng)\s+/i, '').trim();
                        console.error(`[Web Search] Query: "${searchQuery}"`);
                        const searchResults = await searchDuckDuckGo(searchQuery);
                        
                        if (searchResults.length > 0) {
                            searchContext = "\n\n[DỮ LIỆU TÌM KIẾM TRỰC TUYẾN THỜI GIAN THỰC DUCKDUCKGO]:\n";
                            searchResults.forEach((r, idx) => {
                                searchContext += `${idx + 1}. Tiêu đề: ${r.title}\n   Đường dẫn: ${r.link}\n   Tóm tắt: ${r.snippet}\n\n`;
                            });
                            searchContext += "Hãy sử dụng dữ liệu trực tuyến này để biên tập nội dung, tin tức hoặc trả lời câu hỏi của người dùng một cách chính xác nhất.\n";
                        } else {
                            searchContext = "\n\n[DỮ LIỆU TÌM KIẾM TRỰC TUYẾN THỜI GIAN THỰC DUCKDUCKGO]: Không tìm thấy tin tức trực tuyến phù hợp.\n";
                        }
                    }

                    const promptWithContext = text + searchContext;

                    if (deepseekApiKey) {
                        resultText = await callDeepSeek(systemPrompt, promptWithContext, true);
                        console.log("DeepSeek Raw Output:", resultText);
                    } else {
                        const genAI = new GoogleGenerativeAI(geminiApiKey);
                        const model = genAI.getGenerativeModel({
                            model: 'gemini-flash-lite-latest',
                            generationConfig: {
                                responseMimeType: "application/json"
                            }
                        });
                        const result = await model.generateContent([systemPrompt, promptWithContext]);
                        resultText = result.response.text();
                        console.log("Gemini Raw Output:", resultText);
                    }

                    try {
                        parsed = JSON.parse(resultText.trim());
                    } catch (e) {
                        console.log("JSON.parse thất bại, thử dùng Regex trích xuất...");
                        const chatMatch = resultText.match(/"chat_response"\s*:\s*"([\s\S]*?)"\s*(?:,\s*|\s*})/);
                        if (chatMatch) {
                            parsed = { chat_response: chatMatch[1] };
                        } else {
                            throw e;
                        }
                    }

                    if (parsed.beer_type && parsed.price) {
                        if (!webAppUrl) {
                            return bot.sendMessage(chatId, `⚠️ <b>Chưa cấu hình Google Sheet!</b>\n\nĐể lưu dữ liệu bán bia, vui lòng thêm <code>GOOGLE_SHEETS_WEBAPP_URL</code> vào file <code>.env</code>.`, {
                                reply_to_message_id: msg.message_id,
                                parse_mode: 'HTML'
                            });
                        }

                        let statusMsg = await bot.sendMessage(chatId, `⏳ Đang ghi thông tin bán bia (${parsed.beer_type}) lên Google Sheets...`, {
                            reply_to_message_id: msg.message_id
                        });

                        const response = await fetch(webAppUrl, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify(parsed)
                        });

                        if (!response.ok) {
                            throw new Error(`Google Apps Script trả về HTTP ${response.status}`);
                        }

                        const resJson = await response.json();
                        if (resJson.success) {
                            const formattedPrice = new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(parsed.price);
                            const formattedImportPrice = parsed.import_price
                                ? new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(parsed.import_price)
                                : 'Chưa rõ';
                            await bot.editMessageText(
                                `✅ <b>Đã ghi thành công dòng thứ ${resJson.index} vào Google Sheet!</b>\n\n` +
                                `🍺 <b>Loại bia:</b> ${parsed.beer_type}\n` +
                                `🔢 <b>Số lượng:</b> ${parsed.quantity || 1}\n` +
                                `💵 <b>Giá nhập:</b> ${formattedImportPrice}\n` +
                                `💰 <b>Giá bán:</b> ${formattedPrice}\n` +
                                `📅 <b>Ngày bán:</b> ${parsed.date}`,
                                {
                                    chat_id: chatId,
                                    message_id: statusMsg.message_id,
                                    parse_mode: 'HTML'
                                }
                            );
                        } else {
                            throw new Error(resJson.error || "Lỗi không xác định từ Google Apps Script");
                        }
                    } else if (parsed.error === 'missing_price' && parsed.beer_type) {
                        await bot.sendMessage(
                            chatId,
                            `⚠️ Phát hiện loại bia <b>${escapeHtml(parsed.beer_type)}</b> nhưng thiếu thông tin giá bán.\n\n` +
                            `Vui lòng nhắn lại đầy đủ giá bán (Ví dụ: <i>${escapeHtml(parsed.beer_type)} 320k</i> hoặc <i>Bán ${escapeHtml(parsed.beer_type)} 350k</i>).`,
                            {
                                reply_to_message_id: msg.message_id,
                                parse_mode: 'HTML'
                            }
                        );
                    } else if (parsed.chat_response) {
                        // Trả lời chém gió/tâm sự
                        const isMentioned = botInfo && text.includes(`@${botInfo.username}`);
                        const isReplyToBot = msg.reply_to_message && botInfo && msg.reply_to_message.from.id === botInfo.id;
                        
                        // Ở chat riêng tư thì luôn phản hồi, ở nhóm thì chỉ phản hồi khi tag bot hoặc reply bot
                        if (msg.chat.type === 'private' || isMentioned || isReplyToBot) {
                            await bot.sendMessage(chatId, parsed.chat_response, {
                                reply_to_message_id: msg.message_id
                            }).catch(() => {});
                        }
                    }
                } catch (err) {
                    console.error("Lỗi khi xử lý chém gió/Google Sheets:", err);
                    const isSaleHint = /bán|ban|mua|tiger|heineken|333|lon|thùng|thung|giá|gia|k/i.test(text);
                    if (isSaleHint) {
                        await bot.sendMessage(
                            chatId,
                            `❌ <b>Lỗi kết nối AI:</b> ${err.message || 'Yêu cầu quá nhanh, vui lòng thử lại sau giây lát.'}`,
                            {
                                reply_to_message_id: msg.message_id,
                                parse_mode: 'HTML'
                            }
                        ).catch(() => {});
                    }
                }
            }
        }
    });

    return bot;
}

module.exports = { initBot };
