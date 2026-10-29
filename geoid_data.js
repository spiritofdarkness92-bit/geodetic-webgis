// بيانات الجيود المحلية لمدينة الخرطوم (EGM2008)
const khartoumGeoid = [
    { left: 31.5, right: 31.51666, bottom: 16.5, top: 16.51666, SAMPLE_1: 5.024026 },
    { left: 31.5, right: 31.51666, bottom: 16.48334, top: 16.5, SAMPLE_1: 5.019006 },
    { left: 31.5, right: 31.51666, bottom: 16.46668, top: 16.48334, SAMPLE_1: 5.014339 },
    { left: 31.5, right: 31.51666, bottom: 16.45002, top: 16.46668, SAMPLE_1: 5.009786 },
    { left: 31.5, right: 31.51666, bottom: 16.43336, top: 16.45002, SAMPLE_1: 5.005095 }
    // (يمكنك إضافة أو ترك هذه العينة الأولى، أو سيتم اعتماد البحث الهندسي المقرب)
];

module.exports = khartoumGeoid;
