# SAIF CHISHTI SIM DATABASE — `.sim` Command Integration

## مقصد
یہ فائل Cloud/Board developer کو دی جائے تاکہ موجودہ WhatsApp bot میں `.sim` command کو موجودہ authorized SIM-data API کے ساتھ integrate کیا جا سکے۔

> اہم: API صرف اسی data پر استعمال کی جائے جس کے استعمال اور retrieval کی آپ کے پاس قانونی/مجاز اجازت ہو۔ API key/secret کو code یا public repository میں hard-code نہ کیا جائے۔

---

## 1. Command

User group میں:

```text
.sim 03001234567
```

Bot number کو normalize کرے:
- spaces ختم کرے
- `+92`, `0092` یا `92` format کو ضرورت کے مطابق پاکستانی local format `03XXXXXXXXX` میں normalize کرے
- invalid number پر API call نہ کرے

مثال:

```text
.sim +923001234567
```

→

```text
03001234567
```

---

## 2. Environment Variables

Cloud/hosting میں یہ values configure کی جائیں:

```env
SIM_API_URL=https://ft-simdb.ftshehryar10044.workers.dev/ft/api
SIM_API_KEY=
SIM_API_METHOD=GET
SIM_API_PARAM=num
SIM_API_TIMEOUT=10000
SIM_COMMAND=.sim
```

اگر API POST استعمال کرتی ہے:

```env
SIM_API_METHOD=POST
```

اصل API URL اور key developer/owner اپنی authorized API documentation کے مطابق set کرے۔

---

## 3. API Request — GET example

```http
GET {SIM_API_URL}?number=03001234567
Authorization: Bearer {SIM_API_KEY}
Accept: application/json
```

اگر API کا authentication header مختلف ہو تو موجودہ API documentation کے مطابق تبدیل کیا جائے۔

---

## 4. API Request — POST example

```json
{
  "number": "03001234567"
}
```

Headers:

```http
Authorization: Bearer YOUR_API_KEY
Content-Type: application/json
Accept: application/json
```

---

## 5. Expected API Response

Integration کو کسی ایک fixed database schema پر depend نہ کیا جائے۔ Developer اپنی API کے actual response fields کو mapping کے ذریعے اس format میں لائے:

```json
{
  "success": true,
  "found": true,
  "data": {
    "number": "03001234567",
    "status": "Active",
    "network": "Example Network"
  }
}
```

اگر API میں مزید authorized fields موجود ہوں تو صرف وہ fields display کیے جائیں جنہیں owner نے explicitly enable کیا ہو۔

---

## 6. Group Result Design

Result WhatsApp group میں readable box کی صورت میں آئے:

```text
╭━━━〔 SAIF CHISHTI SIM DATABASE 〕━━━╮
┃
┃ 🔎 SIM SEARCH RESULT
┃
┃ 📱 Number : 03001234567
┃ 📡 Network: Example Network
┃ 🟢 Status : Active
┃
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯
```

Footer:

```text
🔐 Data provided through authorized API
⚡ SAIF CHISHTI
```

اگر کوئی sensitive/private field API سے آتی ہو تو اسے default طور پر hide/mask رکھا جائے اور صرف explicitly authorized fields دکھائے جائیں۔

---

## 7. Not Found

```text
╭━━━〔 SAIF CHISHTI SIM DATABASE 〕━━━╮
┃
┃ 🔎 SIM SEARCH
┃
┃ ❌ No matching authorized record found.
┃
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯
```

---

## 8. Invalid Number

```text
╭━━━〔 SAIF CHISHTI SIM DATABASE 〕━━━╮
┃
┃ ⚠️ Invalid number
┃
┃ مثال:
┃ .sim 03001234567
┃
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯
```

---

## 9. API Error / Timeout

API unavailable ہو تو database error یا raw API response group میں نہ دکھایا جائے:

```text
╭━━━〔 SAIF CHISHTI SIM DATABASE 〕━━━╮
┃
┃ ⚠️ Service temporarily unavailable.
┃
┃ Please try again later.
┃
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯
```

---

## 10. Security Requirements

- API key صرف environment variables میں رکھی جائے۔
- API URL/key کو WhatsApp messages، logs یا public GitHub repository میں نہ دکھایا جائے۔
- User input کو sanitize/validate کیا جائے۔
- Request timeout لازمی رکھا جائے۔
- Rate limit/cooldown رکھا جائے تاکہ API پر غیر ضروری load نہ پڑے۔
- Raw API response group میں کبھی نہ بھیجا جائے۔
- Error logs میں API key، authorization header یا sensitive response data نہ لکھا جائے۔
- Bot کے existing command handler/architecture میں command کو integrate کیا جائے؛ الگ duplicate bot نہ بنایا جائے۔
- Existing commands اور existing database functionality کو متاثر نہ کیا جائے۔

---

## 11. Suggested Command Flow

```text
.sim 03001234567
        ↓
Validate number
        ↓
Normalize number
        ↓
Check cooldown/rate limit
        ↓
Call authorized SIM API
        ↓
Map API response
        ↓
Format result
        ↓
Send clean WhatsApp group message
```

---

## 12. Developer Integration Notes

Cloud developer کو یہ کام کرنا ہے:

1. Existing bot کے command system میں `.sim` register کرے۔
2. Environment variables add کرے۔
3. Owner-provided API URL اور API authentication method configure کرے۔
4. Actual API response دیکھ کر field mapping مکمل کرے۔
5. Group response کو اوپر دیے گئے SAIF CHISHTI design کے مطابق format کرے۔
6. API errors اور empty results handle کرے۔
7. Existing bot commands کو نہ توڑے۔
8. Production میں API key کو secret/environment variable کے طور پر رکھے۔

### API Field Mapping

Actual API documentation کے مطابق یہاں mapping مکمل کی جائے:

```text
API number field   → result.number
API status field   → result.status
API network field  → result.network
API name field     → result.name (صرف اگر authorized/display-enabled ہو)
```

---

## 13. Ready-to-use Developer Brief

Cloud/AI developer کو یہ مختصر instruction بھی دی جا سکتی ہے:

> "اس specification کے مطابق میرے existing WhatsApp bot میں `.sim <number>` command integrate کریں۔ میری provided authorized SIM API کو environment variables سے connect کریں، API response کے actual fields کو mapping کریں، اور result کو SAIF CHISHTI SIM DATABASE کے clean WhatsApp format میں send کریں۔ API key hard-code نہ کریں، raw API response expose نہ کریں، timeout/rate-limit/error handling رکھیں، اور existing bot commands کو متاثر نہ کریں۔"


## Configured API
The endpoint above is the endpoint already used by the supplied SIM Database HTML. No API key is hard-coded; if the API later requires authentication, place the key in `SIM_API_KEY` on the server.
