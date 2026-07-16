const puppeteer = require('/Users/admin/Documents/Work/TiktokDownloader/node_modules/puppeteer-core');
const fs = require('fs');
const path = require('path');

// Parse cookie string into Puppeteer cookie format
function parseCookies(cookieStr) {
    if (!cookieStr) return [];
    return cookieStr.split(';').map(pair => {
        const trimmed = pair.trim();
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) return null;
        const name = trimmed.substring(0, eqIdx);
        const value = trimmed.substring(eqIdx + 1);
        return {
            name,
            value,
            domain: '.facebook.com',
            path: '/'
        };
    }).filter(Boolean);
}

async function downloadFile(url, destPath) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Status ${res.status}`);
    const buffer = await res.arrayBuffer();
    fs.writeFileSync(destPath, Buffer.from(buffer));
}

async function run() {
    const args = process.argv.slice(2);
    const targetUrl = args[0];
    if (!targetUrl) {
        console.log(JSON.stringify({ success: false, error: "Missing target URL" }));
        process.exit(1);
    }

    const projectDir = __dirname;
    const mergeDir = path.join(projectDir, "merge_file");
    if (!fs.existsSync(mergeDir)) {
        fs.mkdirSync(mergeDir, { recursive: true });
    }

    // Load env variables
    require('dotenv').config({ path: path.join(projectDir, '.env') });
    const cookieStr = process.env.FACEBOOK_COOKIE;

    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    
    const browser = await puppeteer.launch({
        executablePath,
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process'
        ]
    });

    try {
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1920, height: 1080 });

        // Set cookies if provided
        if (cookieStr) {
            const cookies = parseCookies(cookieStr);
            if (cookies.length > 0) {
                await page.setCookie(...cookies);
            }
        }

        console.error(`[Scraper] Navigating to: ${targetUrl}`);
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 45000 });
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Check if blocked or not found
        const content = await page.content();
        if (content.includes("Sorry, this content isn't available") || page.url().includes('/login/')) {
            console.log(JSON.stringify({
                success: false,
                error: "Không thể truy cập bài viết. Vui lòng kiểm tra lại cấu hình FACEBOOK_COOKIE trong file .env hoặc tính công khai của bài viết."
            }));
            return;
        }

        // If the URL is not a direct photo page, look for the first photo link to enter theatre mode
        if (!targetUrl.includes('/photo') && !targetUrl.includes('photo.php')) {
            console.error("[Scraper] Not a direct photo page. Looking for click target...");
            const photoLink = await page.evaluate(() => {
                const link = document.querySelector('a[href*="/photo"], a[href*="photo.php"]');
                return link ? link.href : null;
            });
            if (photoLink) {
                console.error(`[Scraper] Found photo target, navigating to: ${photoLink}`);
                await page.goto(photoLink, { waitUntil: 'networkidle2', timeout: 30000 });
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        }

        const imageUrls = [];
        let limit = 40; // Max 40 photos
        let currentUrl = null;
        let sameUrlCount = 0;

        console.error("[Scraper] Starting photo extraction loop...");
        while (limit > 0) {
            // Extract the largest image URL currently visible
            const largestImg = await page.evaluate(() => {
                const imgs = Array.from(document.querySelectorAll('img')).filter(img => img.src && img.src.includes('scontent'));
                const candidates = imgs.filter(img => img.naturalWidth > 300 || img.width > 300);
                if (candidates.length === 0) return null;
                candidates.sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight));
                return candidates[0].src;
            });

            if (largestImg) {
                if (imageUrls.includes(largestImg)) {
                    console.error("[Scraper] Image URL already extracted. Loop finished.");
                    break;
                }
                imageUrls.push(largestImg);
                console.error(`[Scraper] Extracted photo ${imageUrls.length}: ${largestImg.substring(0, 80)}...`);
            } else {
                console.error("[Scraper] No image found on this page.");
                break;
            }

            // Move to next photo
            await page.keyboard.press('ArrowRight');
            await new Promise(resolve => setTimeout(resolve, 2000));

            const newUrl = page.url();
            if (newUrl === currentUrl) {
                sameUrlCount++;
                if (sameUrlCount > 2) {
                    console.error("[Scraper] Page URL did not change. Hitting end.");
                    break;
                }
            } else {
                currentUrl = newUrl;
                sameUrlCount = 0;
            }

            limit--;
        }

        if (imageUrls.length === 0) {
            console.log(JSON.stringify({ success: false, error: "Không tìm thấy ảnh nào trong bài đăng." }));
            return;
        }

        console.error(`[Scraper] Downloading ${imageUrls.length} photos...`);
        const downloadedFiles = [];
        
        // Scan current files in merge_file to compute auto-increment prefix
        const existingFiles = fs.readdirSync(mergeDir);
        let maxIndex = 0;
        existingFiles.forEach(f => {
            const m = f.match(/^(\d{5})_/);
            if (m) {
                const idx = parseInt(m[1], 10);
                if (idx > maxIndex) maxIndex = idx;
            }
        });

        for (let i = 0; i < imageUrls.length; i++) {
            const imgUrl = imageUrls[i];
            const fileIndex = maxIndex + i + 1;
            const prefix = String(fileIndex).padStart(5, '0');
            const filename = `${prefix}_fb_photo_${Date.now()}_${i + 1}.jpg`;
            const destPath = path.join(mergeDir, filename);
            
            try {
                await downloadFile(imgUrl, destPath);
                downloadedFiles.push(filename);
            } catch (err) {
                console.error(`[Scraper] Failed to download photo ${i + 1}:`, err.message);
            }
        }

        console.log(JSON.stringify({
            success: true,
            files_downloaded: downloadedFiles,
            total_extracted: imageUrls.length
        }));

    } catch (e) {
        console.log(JSON.stringify({ success: false, error: e.message }));
    } finally {
        await browser.close();
    }
}

run();
