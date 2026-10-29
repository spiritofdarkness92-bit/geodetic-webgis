const dns = require('dns');
dns.setDefaultResultOrder('ipv4first'); // أمر حاسم لإجبار Node.js على استخدام IPv4 وتجاوز قيود شبكة Render

const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// تفعيل Cors واستقبال بيانات JSON من الواجهة الأمامية
app.use(cors());
app.use(express.json());

// قراءة وعرض ملفات المشروع (مثل index.html و الملفات الجغرافية)
app.use(express.static(__dirname));

// إعداد الاتصال بقاعدة بيانات PostgreSQL عبر Supabase بالرابط المباشر لتجاوز مشاكل الـ IPv6 و Render
const pool = new Pool({
    connectionString: 'postgresql://postgres.kofctuvfndybznirqtad:62936015747z@aws-0-eu-central-1.pooler.supabase.com:6543/postgres',
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

// 5. مسار حاسبة الـ RTK واستخراج قيمة N الحسابية من جدول khartoum_geoid (باستخدام أعمدة الـ CSV الصحيحة)
app.post('/api/save-rtk-point', async (req, res) => {
    const { point_name, latitude, longitude, ellipsoidal_h } = req.body;

    if (!point_name || isNaN(latitude) || isNaN(longitude) || isNaN(ellipsoidal_h)) {
        return res.status(400).json({ success: false, error: 'جميع الحقول مطلوبة وبقيم صحيحة' });
    }

    try {
        // 1. البحث المطابق داخل نطاق الخلية (Bounding Box) باستخدام أعمدة الـ CSV
        const findBoxQuery = `
            SELECT "SAMPLE_1" 
            FROM khartoum_geoid 
            WHERE $1 >= left AND $1 <= right 
              AND $2 >= bottom AND $2 <= top
            LIMIT 1;
        `;
        let nearestResult = await pool.query(findBoxQuery, [longitude, latitude]);

        // 2. إذا لم يتم العثور على مطابقة دقيقة بالداخل، يتم جلب أقرب نقطة شبكية هندسياً
        if (nearestResult.rows.length === 0) {
            const fallbackQuery = `
                SELECT "SAMPLE_1" 
                FROM khartoum_geoid 
                ORDER BY (ABS(left - $1) + ABS(bottom - $2)) ASC 
                LIMIT 1;
            `;
            nearestResult = await pool.query(fallbackQuery, [longitude, latitude]);
        }

        let geoid_n = 0.0;
        if (nearestResult.rows.length > 0 && nearestResult.rows[0].SAMPLE_1 !== null) {
            geoid_n = parseFloat(nearestResult.rows[0].SAMPLE_1);
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
        console.error('❌ خطأ أثناء حساب وحفظ نقطة الـ RTK:', err.message);
        res.status(500).json({ success: false, error: 'حدث خطأ في الخادم أثناء معالجة نقطة الـ RTK: ' + err.message });
    }
});

// تشغيل الخادم
app.listen(port, () => {
    console.log(`🚀 الخادم يعمل بنجاح على المنفذ: ${port}`);
});
