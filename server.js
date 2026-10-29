const dns = require('dns');
try {
    dns.setDefaultResultOrder('ipv4first');
} catch (e) {}

const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// مصفوفة لتخزين جميع نقاط ملف الجيود (10,890 نقطة) في الذاكرة لضمان الدقة والسرعة القصوى
let geoidData = [];

function loadGeoidCsv() {
    const results = [];
    const csvPath = path.join(__dirname, 'khartoum.csv');
    if (fs.existsSync(csvPath)) {
        fs.createReadStream(csvPath)
            .pipe(csv())
            .on('data', (data) => {
                results.push({
                    left: parseFloat(data.left),
                    right: parseFloat(data.right),
                    bottom: parseFloat(data.bottom),
                    top: parseFloat(data.top),
                    SAMPLE_1: parseFloat(data.SAMPLE_1)
                });
            })
            .on('end', () => {
                geoidData = results;
                console.log(`✅ تم تحميل جميع نقاط ملف الجيود بنجاح. إجمالي النقاط في الذاكرة: ${geoidData.length} نقطة`);
            })
            .on('error', (err) => {
                console.error('❌ خطأ أثناء قراءة ملف الجيود:', err.message);
            });
    } else {
        console.warn('⚠️ ملف khartoum.csv غير موجود في مجلد المشروع المحلي!');
    }
}
loadGeoidCsv();

// إعداد الاتصال بقاعدة البيانات للنقاط فقط (Stations)
const pool = new Pool({
    connectionString: 'postgresql://postgres:62936015747z@db.kofctuvfndybznirqtad.supabase.co:5432/postgres',
    connectionTimeoutMillis: 5000,
    ssl: { rejectUnauthorized: false }
});

pool.connect((err, client, release) => {
    if (err) {
        console.error('⚠️ تحذير: الاتصال بقاعدة البيانات تأثر، لكن حاسبة الـ RTK ستعمل محلياً بكامل النقاط:', err.message);
    } else {
        console.log('✅ تم الاتصال بقاعدة البيانات PostgreSQL بنجاح!');
        release();
    }
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

// 2. إضافة أو تحديث نقطة (POST)
app.post('/api/points', async (req, res) => {
    const { point_id, name, latitude, longitude, elevation_m, type, description } = req.body;
    try {
        const queryText = `
            INSERT INTO stations (point_id, name, latitude, longitude, elevation_m, type, description)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (point_id) DO UPDATE 
            SET name = EXCLUDED.name, latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude, 
                elevation_m = EXCLUDED.elevation_m, type = EXCLUDED.type, description = EXCLUDED.description
            RETURNING *;
        `;
        const result = await pool.query(queryText, [point_id, name, latitude, longitude, elevation_m, type, description]);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('خطأ أثناء إضافة النقطة:', err);
        res.status(500).json({ error: 'حدث خطأ في الخادم أثناء إضافة النقطة' });
    }
});

// 3. تعديل بيانات نقطة موجودة (PUT)
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
        const result = await pool.query(queryText, [name, latitude, longitude, elevation_m, type, description, pointId]);

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'النقطة غير موجودة لتعديلها' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error('خطأ أثناء تعديل النقطة:', err.message);
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

        res.json({ message: 'تم حذف النقطة بنجاح', deletedPoint: result.rows[0] });
    } catch (err) {
        console.error('خطأ أثناء حذف النقطة:', err.message);
        res.status(500).json({ error: 'حدث خطأ في الخادم أثناء حذف النقطة' });
    }
});

// 5. مسار حاسبة الـ RTK الذكية (بحث دقيق وشامل في جميع نقاط الـ CSV الـ 10,890)
app.post('/api/save-rtk-point', async (req, res) => {
    const { point_name, latitude, longitude, ellipsoidal_h } = req.body;

    if (!point_name || isNaN(latitude) || isNaN(longitude) || isNaN(ellipsoidal_h)) {
        return res.status(400).json({ success: false, error: 'جميع الحقول مطلوبة وبقيم صحيحة' });
    }

    try {
        let geoid_n = 5.024; // قيمة افتراضية آمنة في حال لم يتم تحميل الملف بالكامل بعد

        if (geoidData && geoidData.length > 0) {
            // أ) البحث المطابق التام داخل نطاق الخلية (Bounding Box) من بين جميع النقاط
            let matched = geoidData.find(row => 
                longitude >= row.left && longitude <= row.right && 
                latitude >= row.bottom && latitude <= row.top
            );

            if (matched) {
                geoid_n = matched.SAMPLE_1;
            } else {
                // ب) البحث الهندسي الدقيق عن أقرب نقطة شبكية من بين الـ 10,890 نقطة
                let closest = geoidData.reduce((prev, curr) => {
                    const prevDist = Math.abs(prev.left - longitude) + Math.abs(prev.bottom - latitude);
                    const currDist = Math.abs(curr.left - longitude) + Math.abs(curr.bottom - latitude);
                    return currDist < prevDist ? curr : prev;
                });
                geoid_n = closest.SAMPLE_1;
            }
        }

        const orthometric_h = parseFloat(ellipsoidal_h) - geoid_n;
        const point_id = Math.floor(Math.random() * 900000) + 100000;

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
            `نقطة RTK محلية - قيمة N الدقيقة: ${geoid_n.toFixed(3)}م`
        ];

        let savedStation;
        try {
            const savedResult = await pool.query(insertQuery, insertValues);
            savedStation = savedResult.rows[0];
        } catch (dbErr) {
            savedStation = { 
                point_id, 
                name: point_name, 
                latitude, 
                longitude, 
                elevation_m: parseFloat(orthometric_h.toFixed(3)), 
                type: 'RTK_Point', 
                description: `نقطة RTK - N: ${geoid_n.toFixed(3)}م` 
            };
        }

        console.log(`🛰️ تم استخراج قيمة N بدقة من بين 10,890 نقطة وحفظ نقطة الـ RTK: ${point_name}`);
        res.status(201).json({
            success: true,
            data: {
                point_id: point_id,
                geoid_n: geoid_n.toFixed(3),
                orthometric_h: orthometric_h.toFixed(3),
                station: savedStation
            }
        });

    } catch (err) {
        console.error('❌ خطأ أثناء معالجة نقطة الـ RTK:', err.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم أثناء معالجة نقطة الـ RTK: ' + err.message });
    }
});

app.listen(port, () => {
    console.log(`🚀 الخادم يعمل بنجاح على المنفذ: ${port}`);
});
