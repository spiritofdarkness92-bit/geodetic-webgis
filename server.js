const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const readline = require('readline'); // مكتبة مدمجة آمنة لا تحتاج تثبيت وتمنع فشل البناء على Render

const app = express();
const port = process.env.PORT || 3000;

// تفعيل Cors واستقبال بيانات JSON من الواجهة الأمامية
app.use(cors());
app.use(express.json());

// قراءة وعرض ملفات المشروع (مثل index.html و الملفات الجغرافية)
app.use(express.static(__dirname));

// تخزين بيانات ملف الجيود بالكامل (10,890 نقطة) في الذاكرة محلياً لضمان السرعة والدقة المطلقة
let geoidData = [];

async function loadGeoidCsv() {
    const csvPath = path.join(__dirname, 'khartoum.csv');
    if (!fs.existsSync(csvPath)) {
        console.warn('⚠️ ملف khartoum.csv غير موجود في مجلد المشروع المحلي!');
        return;
    }

    const fileStream = fs.createReadStream(csvPath);
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
    });

    let isHeader = true;
    for await (const line of rl) {
        if (isHeader) {
            isHeader = false; // تخطي سطر العناوين
            continue;
        }
        if (!line.trim()) continue;

        const parts = line.split(',');
        // الأعمدة حسب ملف khartoum.csv: id, left, top, right, bottom, row_index, col_index, SAMPLE_1
        if (parts.length >= 8) {
            geoidData.push({
                left: parseFloat(parts[1]),
                top: parseFloat(parts[2]),
                right: parseFloat(parts[3]),
                bottom: parseFloat(parts[4]),
                SAMPLE_1: parseFloat(parts[7])
            });
        }
    }
    console.log(`✅ تم تحميل جميع نقاط ملف الجيود محلياً بنجاح. إجمالي النقاط في الذاكرة: ${geoidData.length} نقطة`);
}
loadGeoidCsv();

// إعداد الاتصال المباشر بقاعدة بيانات PostgreSQL عبر Supabase لمنع أخطاء الشبكة
const pool = new Pool({
    connectionString: 'postgresql://postgres:62936015747z@db.kofctuvfndybznirqtad.supabase.co:5432/postgres',
    ssl: {
        rejectUnauthorized: false // ضروري جداً للاتصال بقواعد بيانات Supabase من منصة سحابية
    }
});

// التحقق من الاتصال بقاعدة البيانات
pool.connect((err, client, release) => {
    if (err) {
        return console.error('❌ خطأ في الاتصال بقاعدة البيانات:', err.stack);
    }
    console.log('✅ تم الاتصال بقاعدة البيانات PostgreSQL بنجاح!');
    release();
});

// 1. جلب جميع النقاط (GET)
app.get('/api/points', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM stations ORDER BY point_id ASC');
        res.json(result.rows);
    } catch (err) {
        console.error('خطأ أثناء جلب البيانات:', err);
        res.status(500).json({ error: 'حدث خطأ في الخادم أثناء جلب النقاط' });
    }
});

// 2. إضافة أو تحديث نقطة (POST - مدعوم بـ Upsert لمنع الأخطاء عند رفع الملفات المتكررة)
app.post('/api/points', async (req, res) => {
    const { point_id, name, latitude, longitude, elevation_m, type, description } = req.body;

    try {
        const queryText = `
            INSERT INTO stations (point_id, name, latitude, longitude, elevation_m, type, description)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (point_id) DO UPDATE 
            SET name = EXCLUDED.name, 
                latitude = EXCLUDED.latitude, 
                longitude = EXCLUDED.longitude, 
                elevation_m = EXCLUDED.elevation_m, 
                type = EXCLUDED.type, 
                description = EXCLUDED.description
            RETURNING *;
        `;
        const values = [point_id, name, latitude, longitude, elevation_m, type, description];
        
        const result = await pool.query(queryText, values);
        console.log('➕ تم إضافة أو تحديث نقطة:', result.rows[0]);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('خطأ أثناء إضافة النقطة:', err);
        res.status(500).json({ error: 'حدث خطأ في الخادم أثناء إضافة النقطة' });
    }
});

// 3. تعديل بيانات نقطة موجودة (PUT - مطلوب لخاصية التعديل في الواجهة)
app.put('/api/points/:id', async (req, res) => {
    const pointId = req.params.id;
    const { name, latitude, longitude, elevation_m, type, description } = req.body;

    try {
        const queryText = `
            UPDATE stations 
            SET name = $1, latitude = $2, longitude = $3, elevation_m = $4, type = $5, description = $6
            WHERE point_id = $7
            RETURNING *;
        `;
        const values = [name, latitude, longitude, elevation_m, type, description, pointId];
        const result = await pool.query(queryText, values);

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'النقطة غير موجودة لتعديلها' });
        }

        console.log(`✏️ تم تحديث بيانات النقطة رقم: ${pointId}`);
        res.json(result.rows[0]);
    } catch (err) {
        console.error('خطأ أثناء تعديل النقطة:', err);
        res.status(500).json({ error: 'حدث خطأ في الخادم أثناء تعديل النقطة' });
    }
});

// 4. حذف نقطة من قاعدة البيانات (DELETE)
app.delete('/api/points/:id', async (req, res) => {
    const pointId = req.params.id;

    try {
        const queryText = 'DELETE FROM stations WHERE point_id = $1 RETURNING *;';
        const result = await pool.query(queryText, [pointId]);

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'النقطة غير موجودة' });
        }

        console.log(`🗑️ تم حذف النقطة رقم: ${pointId}`);
        res.json({ message: 'تم حذف النقطة بنجاح', deletedPoint: result.rows[0] });
    } catch (err) {
        console.error('خطأ أثناء حذف النقطة:', err);
        res.status(500).json({ error: 'حدث خطأ في الخادم أثناء حذف النقطة' });
    }
});

// 5. مسار حاسبة الـ RTK واستخراج قيمة N الحسابية محلياً بدقة تامة من بين جميع نقاط الـ CSV (10,890 نقطة)
app.post('/api/save-rtk-point', async (req, res) => {
    const { point_name, latitude, longitude, ellipsoidal_h } = req.body;

    if (!point_name || isNaN(latitude) || isNaN(longitude) || isNaN(ellipsoidal_h)) {
        return res.status(400).json({ success: false, error: 'جميع الحقول مطلوبة وبقيم صحيحة' });
    }

    try {
        let geoid_n = 0.0;

        if (geoidData && geoidData.length > 0) {
            // أ) البحث المطابق التام داخل نطاق الخلية (Bounding Box)
            let matched = geoidData.find(row => 
                longitude >= row.left && longitude <= row.right && 
                latitude >= row.bottom && latitude <= row.top
            );

            if (matched) {
                geoid_n = matched.SAMPLE_1;
            } else {
                // ب) البحث الهندسي الدقيق عن أقرب نقطة شبكية من بين جميع النقاط
                let closest = geoidData.reduce((prev, curr) => {
                    const prevDist = Math.abs(prev.left - longitude) + Math.abs(prev.bottom - latitude);
                    const currDist = Math.abs(curr.left - longitude) + Math.abs(curr.bottom - latitude);
                    return currDist < prevDist ? curr : prev;
                });
                geoid_n = closest.SAMPLE_1;
            }
        }

        // حساب الارتفاع الأرثومتري: H = h - N
        const orthometric_h = parseFloat(ellipsoidal_h) - geoid_n;
        const point_id = Math.floor(Math.random() * 900000) + 100000;

        // حفظ النقطة الجديدة في جدول stations الرئيسي
        const insertQuery = `
            INSERT INTO stations (point_id, name, latitude, longitude, elevation_m, type, description)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *;
        `;
        const insertValues = [
            point_id, 
            point_name, 
            latitude, 
            longitude, 
            parseFloat(orthometric_h.toFixed(3)), 
            'RTK_Point', 
            `نقطة RTK محسوبة آلياً - قيمة N: ${geoid_n.toFixed(3)}م`
        ];

        const savedResult = await pool.query(insertQuery, insertValues);

        console.log(`🛰️ تم حساب وحفظ نقطة RTK بنجاح: ${point_name}`);
        res.status(201).json({
            success: true,
            data: {
                point_id: point_id,
                geoid_n: geoid_n.toFixed(3),
                orthometric_h: orthometric_h.toFixed(3),
                station: savedResult.rows[0]
            }
        });

    } catch (err) {
        console.error('خطأ أثناء حساب وحفظ نقطة الـ RTK:', err);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم أثناء معالجة نقطة الـ RTK' });
    }
});

// تشغيل الخادم
app.listen(port, () => {
    console.log(`🚀 الخادم يعمل بنجاح على المنفذ: ${port}`);
});
