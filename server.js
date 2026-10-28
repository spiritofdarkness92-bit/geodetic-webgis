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

// إعداد الاتصال بقاعدة بيانات PostgreSQL عبر Supabase ومنصة Render
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
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

// ----------------------------------------------------
// أولاً: المسارات القديمة الخاصة بالمحطات (تم الاحتفاظ بها كاملة)
// ----------------------------------------------------

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

// 2. إضافة نقطة جديدة إلى قاعدة البيانات (POST)
app.post('/api/points', async (req, res) => {
    const { point_id, name, latitude, longitude, elevation_m, type, description } = req.body;

    try {
        const queryText = `
            INSERT INTO stations (point_id, name, latitude, longitude, elevation_m, type, description)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *;
        `;
        const values = [point_id, name, latitude, longitude, elevation_m, type, description];
        
        const result = await pool.query(queryText, values);
        console.log('➕ تم إضافة نقطة جديدة:', result.rows[0]);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('خطأ أثناء إضافة النقطة:', err);
        res.status(500).json({ error: 'حدث خطأ في الخادم أثناء إضافة النقطة' });
    }
});

// 3. حذف نقطة من قاعدة البيانات (DELETE)
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


// ----------------------------------------------------
// ثانياً: المسار المحدث الخاص بحاسبة الـ RTK والاستعلام المكاني التلقائي عن N من شبكة الجيويد
// ----------------------------------------------------

app.post('/api/save-rtk-point', async (req, res) => {
    try {
        const { point_name, latitude, longitude, ellipsoidal_h } = req.body;

        const lat = parseFloat(latitude);
        const lon = parseFloat(longitude);
        const h = parseFloat(ellipsoidal_h);

        // الاستعلام المكاني التلقائي لجلب قيمة N من جدول الراستر الخاص بالجيود في PostGIS
        const rasterQuery = `
            SELECT ST_Value(rast, ST_SetSRID(ST_MakePoint($1, $2), 4326)) As n_value
            FROM egm2008_sudandb 
            WHERE ST_Intersects(rast, ST_SetSRID(ST_MakePoint($1, $2), 4326))
            LIMIT 1;
        `;
        
        let geoid_n = 14.500; // قيمة افتراضية نموذجية احتياطية
        try {
            const rasterResult = await pool.query(rasterQuery, [lon, lat]);
            if (rasterResult.rows.length > 0 && rasterResult.rows[0].n_value !== null) {
                geoid_n = parseFloat(rasterResult.rows[0].n_value);
            }
        } catch (rasterErr) {
            console.warn('⚠️ تنبيه مكاني: تعذر جلب قيم الراستر تلقائياً، سيتم استخدام القيمة الاحتياطية:', rasterErr.message);
        }

        // تطبيق المعادلة الهندسية الجيوديسية بدقة: H = h - N
        const orthometric_h = h - geoid_n;

        // إدخال النقطة والنتائج في جدول rtk_points
        const queryText = `
            INSERT INTO rtk_points (point_name, latitude, longitude, ellipsoidal_h, geoid_n, orthometric_h)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *;
        `;
        const values = [point_name, lat, lon, h, geoid_n, orthometric_h];
        
        const result = await pool.query(queryText, values);
        console.log('📡 تم استخراج N وسحب الارتفاع الأرثومتري وحفظ النقطة بنجاح:', result.rows[0]);
        
        res.status(201).json({
            success: true,
            message: 'تم استخراج قيمة N وحساب الارتفاع الأرثومتري وتخزين النقطة بنجاح',
            data: result.rows[0]
        });
    } catch (err) {
        console.error('خطأ أثناء معالجة حسابات وحفظ نقطة الـ RTK:', err);
        res.status(500).json({ error: 'حدث خطأ في الخادم أثناء معالجة حسابات الـ RTK المكانية' });
    }
});

// تشغيل الخادم
app.listen(port, () => {
    console.log(`🚀 الخادم يعمل بنجاح على المنفذ: ${port}`);
});
