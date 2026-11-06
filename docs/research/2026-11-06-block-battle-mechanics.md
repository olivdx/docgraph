# Research: cơ chế đấu xếp khối nhiều người ("Royale / Attack + Sabotage")

Ngày: 2026-11-06
Trạng thái: Research, chưa phải spec. Chưa có quyết định nào của owner trong tài liệu này; các con số đánh dấu **Đề xuất** là gợi ý để owner chốt.
Phạm vi: mechanic gameplay, chế độ chơi, điều khiển trên Telegram, kiến trúc mạng khớp với stack hiện tại (Next.js trên Vercel, MongoDB, Ably), rủi ro tên gọi.

---

## 0. Tóm tắt

1. **Ý tưởng khả thi và đã được thị trường kiểm chứng.** Bảng tấn công, hàng chờ garbage, triệt tiêu (counter), nhắm mục tiêu và huy hiệu KO đều có tài liệu công khai chi tiết từ Tetris 99, TETR.IO, Tetris Battle (Facebook) và TetriNET. Nên dựng trên các bảng chuẩn đó thay vì tự đặt số.
2. **Bảng "đẩy hàng" trong ý tưởng gần đúng chuẩn**, chỉ khác ở Tetris = "4–6 hàng". Trong chuẩn, Tetris luôn gửi 4; con số lên 5–6 đến từ **Back-to-Back (+1)** và **combo**, không phải từ một khoảng ngẫu nhiên. Nên làm theo cách đó để người chơi đoán được sát thương.
3. **"Gạch khóa cần xóa 2 lần" không có tiền lệ trực tiếp** và phá quy tắc "hàng đầy thì mất". Các tiền lệ gần nhất là garbage đặc (không có lỗ), garbage có bom, và gem đếm ngược của Puzzle Fighter. Khuyến nghị: không đưa vào luật cơ bản, chỉ cân nhắc trong chế độ Item.
4. **Bốn kiểu nhắm mục tiêu trong ý tưởng trùng gần như nguyên bản với Tetris 99** (Random, Attackers, KOs, Badges). Các hệ số của Tetris 99 được thiết kế cho 99 người; phòng 2–8 người cần thu nhỏ lại.
5. **Kiến trúc hiện tại không mang được game này.** Ably đang chỉ là "chuông cửa": server phát `{v}`, client chỉ được subscribe rồi gọi lại API. Game xếp khối cần đẩy tấn công giữa người chơi trong khoảng 100 ms. Cách hợp lý nhất là **cho client publish trực tiếp lên kênh Ably của phòng**, mỗi client tự quyết bảng của mình. Muốn chống gian lận cho giải đấu thì kiểm tra lại bằng replay trên server.
6. **Chi phí Ably là ràng buộc thật.** Gói Free giới hạn 500 message/giây cho cả tài khoản. Một phòng 8 người gửi bảng thu nhỏ 6 lần/giây đã tốn khoảng 430 message/giây. Phải gộp snapshot vào sự kiện đặt khối và tắt echo (mục 10.4).
7. **Không dùng chữ "Tetris" trong tên và không sao chép nhận diện hình ảnh của Tetris.** "Tetris Royale" còn là tên một sản phẩm thật của N3TWORK (mục 11).

---

## 1. Nguồn tham khảo chính

| Nguồn | Dùng cho |
|---|---|
| TetrisWiki: Garbage, Combo, Tetris Guideline, Tetris 99, TETR.IO, Tetris Battle, Tetris Effect | Bảng tấn công, combo, luật lõi, nhắm mục tiêu, huy hiệu |
| Hard Drop Wiki: Garbage, Tetris 99, Multiplayer Techniques, Tetris Battle, TetriNET | Thời gian garbage vào bảng, counter, garbage blocking, item |
| Tetris Design Guideline 2009 (bản lưu trữ) | Lock delay, hold, điều kiện thua |
| TETR.IO wiki và tài liệu cấu hình phòng | Combo kiểu nhân, B2B charging/Surge, margin time, độ lộn xộn của garbage, passthrough |
| Blog osk (tác giả TETR.IO), diễn đàn Jstris | Engine dùng chung client/server, replay = seed + log thao tác |
| Tài liệu Ably (giới hạn, cách đếm message, latency), bài so sánh Vercel WebSockets | Kiến trúc mạng và chi phí |
| Phán quyết Tetris Holding v. Xio Interactive (D.N.J. 2012) | Rủi ro pháp lý |

Đường dẫn đầy đủ ở mục 13.

---

## 2. Luật lõi phải cố định trước khi làm phần đấu

Phần đấu chỉ công bằng khi mọi người chơi cùng một bộ luật. Đây là các tham số chuẩn Guideline; mọi game đấu nghiêm túc đều theo gần như nguyên bản.

| Mục | Chuẩn | Ghi chú cho dự án |
|---|---|---|
| Bàn chơi | Rộng 10, cao 20 hàng nhìn thấy, cộng vùng đệm phía trên | Vùng đệm giúp garbage đẩy stack lên mà chưa thua ngay |
| Bộ sinh khối | **7-bag**: mỗi "túi" có đủ 7 khối, xáo trộn rồi phát lần lượt | **Mọi người trong phòng dùng cùng một seed** để chuỗi khối giống nhau; Jstris làm vậy (PRNG Alea + seed) |
| Xoay | SRS (Super Rotation System) có wall kick và floor kick | Cần có để T-Spin hoạt động |
| Hold | Giữ 1 khối, không được hold lại cho đến khi khối hiện tại khóa | |
| Next | Guideline cho phép 1–6 khối xem trước; Tetris 99 hiện 6 | **Đề xuất:** 5, vừa màn hình điện thoại |
| Lock delay | 0,5 s sau khi chạm mặt; kiểu "move reset": tối đa 15 lần di chuyển/xoay làm mới bộ đếm | Guideline yêu cầu kiểu này cho chế độ nhiều người |
| DAS / ARR | Guideline cũ: DAS khoảng 0,3 s. Puyo Puyo Tetris / Tetris Effect: DAS 167 ms, ARR 33 ms, ARE 100 ms | Trên cảm ứng ít liên quan hơn (mục 9) |
| Thua | Lock Out (khóa khối hoàn toàn trên đường trời), Block Out (khối mới không sinh ra được), Top Out (garbage đẩy stack vượt vùng đệm) | Cả ba cần áp dụng |
| T-Spin | Quy tắc 3 góc: thao tác cuối là xoay, và ít nhất 3/4 ô chéo quanh tâm khối T bị chiếm; "Mini" nếu chưa đủ 2 góc phía trước | Bắt buộc nếu bảng tấn công thưởng T-Spin |

**Hệ quả thiết kế:** engine phải **xác định (deterministic)**. Cùng seed và cùng chuỗi thao tác phải cho ra cùng bảng. Điều kiện này cần cho replay, chống gian lận và debug (mục 10).

---

## 3. Bảng tấn công (gửi bao nhiêu hàng garbage)

### 3.1 Bảng chuẩn Guideline

| Kiểu xóa | Hàng xóa | Hàng gửi |
|---|---|---|
| Single | 1 | 0 |
| Double | 2 | 1 |
| Triple | 3 | 2 |
| Tetris (4 hàng) | 4 | 4 |
| T-Spin Mini Single | 1 | 0 |
| T-Spin Mini Double | 2 | 1 |
| T-Spin Single | 1 | 2 |
| T-Spin Double | 2 | 4 |
| T-Spin Triple | 3 | 6 |
| Back-to-Back | – | +1 (đa số game; vài game cho +2/+3 với đòn lớn) |
| Perfect Clear (sạch bàn) | 1–4 | Guideline: 10; Tetris 99: +4; TETR.IO Quick Play: 3 và +2 B2B |

**Back-to-Back (B2B):** hai đòn "khó" liên tiếp (Tetris hoặc T-Spin) mà không xen một Single/Double/Triple thường. Đây là cơ chế thưởng việc giữ kỷ luật xếp.

### 3.2 Combo (xóa hàng ở nhiều khối liên tiếp)

Mỗi khối đặt xuống mà có xóa ít nhất 1 hàng thì combo tăng 1; khối không xóa hàng thì combo về lại. Bảng cộng thêm hàng:

| Combo | Guideline chuẩn | Tetris 99 | Puyo Puyo Tetris 2 | Tetris Effect: Connected |
|---|---|---|---|---|
| 1 | 0 | 1 | 0 | 0 |
| 2 | 1 | 1 | 1 | 1 |
| 3 | 1 | 2 | 1 | 1 |
| 4 | 2 | 2 | 2 | 2 |
| 5 | 2 | 3 | 2 | 2 |
| 6 | 3 | 3 | 3 | 2 |
| 7 | 3 | 4 | 3 | 3 |
| 8 | 4 | 4 | 4 | 3 |
| 9 | 4 | 4 | 4 | 3 |
| 10 | 4 | 5 | 4 | 3 |
| 11 | 5 | 5 | 4 | 3 |
| 12 | 5 | 5 | 4 | 3 |
| 13+ | 5 | 5 | 5 | 4 |

TETR.IO dùng hệ **nhân**: `base × (1 + 0.25 × combo)`. Nếu đòn gốc bằng 0 thì dùng `ln(1 + 1.25 × combo)` từ combo 2. Mục đích là giảm sức mạnh lối "four-wide" (chừa giếng rộng 4 ô để combo dài) và thưởng combo kết thúc bằng Tetris/T-Spin. Hệ này cần làm tròn, nên khó giải thích cho người chơi bình thường.

### 3.3 Cách TETR.IO thưởng chuỗi B2B dài (Surge)

Từ 2024, TETR.IO dùng "B2B Charging": mỗi đòn trong chuỗi B2B gửi thêm 1 hàng. Từ B2B 4 trở lên, game tích một đòn **Surge** (4 hàng ở chế độ thường, mỗi mức B2B thêm 1), xả toàn bộ khi chuỗi bị phá, chia làm 3 đợt. Cơ chế này tạo khoảnh khắc "bùng nổ" rất hợp tinh thần "Sabotage", nhưng khó cân bằng ở phòng 8 người trình độ chênh lệch.

### 3.4 Giới hạn

Tetris 99 giới hạn **tối đa 20 hàng mỗi đòn** và **tối đa 12 hàng trong hàng chờ** của người nhận; phần dư bị bỏ. Không có giới hạn thì một Perfect Clear cộng huy hiệu có thể giết người ngay lập tức.

### 3.5 Đối chiếu với ý tưởng gốc

| Ý tưởng gốc | Chuẩn | Nhận xét |
|---|---|---|
| Xóa 1 hàng: 0 hoặc tích năng lượng | 0 | Khớp. "Tích năng lượng" hợp với chế độ Item (mục 7.4), không nên có ở chế độ cơ bản |
| Xóa 2 hàng: 1 | 1 | Khớp |
| Xóa 3 hàng: 2 | 2 | Khớp |
| Tetris / combo: 4–6 + gạch khóa | 4; B2B thành 5; combo cộng thêm | Nên để 5–6 đến từ B2B và combo, không random. Gạch khóa: xem mục 5 |
| (Không nhắc) T-Spin | 2/4/6 | Nên có. Đây là kỹ năng chiều sâu chính của game đấu hiện đại |

**Đề xuất cho chế độ cơ bản:** bảng Guideline ở 3.1, B2B +1, combo cột "Guideline chuẩn", Perfect Clear 10, mỗi đòn tối đa 20 hàng, hàng chờ tối đa 12. Đây là bộ số dễ dạy và dễ đoán nhất.

---

## 4. Vòng đời của garbage: từ lúc bị tấn công đến lúc lên bàn

Đây là phần quyết định game "căng" hay "ức chế". Các game làm rất khác nhau.

### 4.1 Hàng chờ và triệt tiêu (counter)

Garbage không lên bàn ngay. Nó vào **hàng chờ (receiving queue)** của người nhận, hiển thị bằng một thanh dọc cạnh bàn. Khi người nhận xóa hàng có sức tấn công, sức tấn công đó **trừ vào hàng chờ trước**; phần dư mới bay sang đối thủ. Đây là luật của hầu hết game Guideline từ Tetris DS trở đi, và tạo nên cảm giác "đỡ đòn rồi phản đòn".

### 4.2 Khi nào garbage vào bàn

| Kiểu | Hành vi | Game |
|---|---|---|
| Vào khi đặt khối | Đặt khối bất kỳ thì toàn bộ hàng chờ vào bàn | Tetris Battle (có counter, không blocking) |
| **Garbage blocking** | Chỉ vào khi đặt một khối **không** xóa hàng; đang combo thì hoãn được | Tetris Online Japan, Tetris Effect Zone Battle |
| Có đồng hồ | Mỗi đợt đổi màu theo thời gian (vàng, đỏ, đỏ nhấp nháy) rồi mới "được phép" vào; đợt sau màu xám chờ đợt trước | Tetris 99: vàng 2,5 s rồi đỏ; thời gian rút xuống 1,5 s khi còn 50 người và 0,5 s khi còn 10 người |
| Có đồng hồ, nhanh dần | Vàng, đỏ trong suốt, đỏ đặc; nhanh hơn ở tầng cao | TETR.IO |

### 4.3 Giới hạn số hàng vào bàn mỗi lần đặt khối

TETR.IO có tham số "garbage cap": số hàng tối đa đi vào bàn trong một lần, tăng dần theo thời gian. Bản mobile Tetris của N3TWORK cho giới hạn hàng chờ bắt đầu ở 4, cứ 15 giây tăng 2, tối đa 14. Cả hai đều nhằm tránh chết vì một đòn lớn ở đầu trận.

### 4.4 Vị trí lỗ (độ "lộn xộn")

- **Sạch:** cả đợt garbage chung một cột lỗ. Dễ đào, khuyến khích phản đòn. Tetris 99 gần như vậy; Hard Drop nhận xét người giỏi thường không để garbage tồn trên bàn.
- **Lộn xộn:** mỗi hàng có xác suất đổi cột. TETR.IO cho xác suất đổi cột giữa hai đòn khác nhau cao gấp 2,5 lần so với trong cùng một đòn.
- Tetris Effect Zone Battle cho lỗ sạch ở đầu trận và lộn xộn dần theo điểm.

### 4.5 "Passthrough": hai bên tấn công cùng lúc

Khi A và B cùng tung đòn gần như đồng thời, có hai cách:
- **Không passthrough:** đòn của B triệt tiêu đòn đang bay của A.
- **Passthrough:** cả hai đều ăn đủ. TETR.IO từng bật mặc định (garbage bay 20 frame, khoảng 0,33 s, không bị triệt tiêu). Sau khảo sát cộng đồng năm 2021, họ **tắt mặc định** vì cơ chế này quyết định quá nhiều trận xếp hạng.

Với mạng không có server trung tâm (mục 10), passthrough gần như **tự xảy ra** khi hai đòn bay ngược chiều trong cùng khoảng trễ. Cần chấp nhận điều này hoặc thiết kế để triệt tiêu "phía nhận" (người nhận tự trừ hàng chờ của mình).

### 4.6 Đề xuất

- Có counter và garbage blocking (combo được thưởng thêm khả năng phòng thủ).
- Đồng hồ vào bàn khoảng **1,5 s** ở đầu trận, rút dần theo thời gian hoặc số người bị loại. Tetris 99 dùng 2,5 s cho 99 người; phòng nhỏ đánh nhanh hơn nên có thể ngắn hơn.
- Mỗi lần đặt khối nhận tối đa **8 hàng**; phần còn lại ở lại hàng chờ.
- Lỗ sạch trong một đòn, đổi cột giữa các đòn với xác suất khoảng 30–50%. Con số cần chơi thử để chốt.

---

## 5. Đánh giá "gạch khóa: cần xóa 2 lần mới mất"

Ý tưởng: đòn lớn gửi kèm hàng đặc biệt, phải xóa 2 lần mới biến mất.

**Tiền lệ gần nhất:**

| Cơ chế | Game | Cách hoạt động |
|---|---|---|
| Garbage đặc (solid) | Tetris Friends Battle 2P, Tetris Battle | Hàng không có lỗ, không thể xóa bằng cách lấp đầy. Chỉ giảm được bằng cách **gửi đòn đi** |
| Garbage có bom | Tetris Battle | Mỗi hàng có một "bom" thay cho lỗ. Thả khối lên bom thì hàng đó nổ; bom chồng cùng cột nổ dây chuyền. Nổ bom không phá chuỗi combo/B2B |
| Counter gem đếm ngược | Super Puzzle Fighter | Gem rơi xuống có bộ đếm (thường 5), giảm 1 mỗi lần đặt, về 0 mới thành gem thường để xóa được |
| Garbage không xóa được | Jstris, NullpoMino | Dùng làm cơ chế "kết thúc trận" khi kéo quá lâu |

**Vấn đề nếu làm đúng như mô tả:**
1. Phá quy tắc người chơi hiểu sẵn ("hàng đầy thì mất"), nên phải dạy thêm.
2. Lúc xóa hàng thường thì hàng khóa ở lại, làm sai tính toán combo và thời điểm Tetris. Engine phải định nghĩa rõ: hàng khóa có tính là "đã xóa" để tăng combo không, có gửi đòn không.
3. Cộng với hàng chờ và counter, sát thương thực tế thành ra khó đoán.

**Khuyến nghị:**
- Không đưa vào chế độ cơ bản.
- Nếu muốn có ở chế độ Item, chọn một biến thể đã được kiểm chứng: **garbage đặc** (chỉ giảm bằng cách gửi đòn) hoặc **hàng có lỗ bị "đóng băng"** theo kiểu Puzzle Fighter (lỗ bị lấp tạm, mở lại sau N khối). Cả hai đều dễ hiển thị và dễ giải thích hơn "xóa 2 lần".

---

## 6. Nhắm mục tiêu, KO và huy hiệu

### 6.1 Bốn chế độ của Tetris 99 và đối chiếu ý tưởng

| Ý tưởng gốc | Tetris 99 | Hành vi trong Tetris 99 |
|---|---|---|
| Random | Randoms | Mục tiêu ngẫu nhiên (Hard Drop ghi nhận có thể ưu tiên người cấp cao). Mặc định, ít bị phản đòn nhất |
| Payback | Attackers | Đánh **tất cả** những ai đang nhắm mình; sát thương **chia đều** giữa họ |
| KO Hunter | KOs | Nhắm người gần chạm trần nhất |
| Top Player | Badges | Nhắm người nhiều huy hiệu nhất |

Tetris 99 còn cho chọn mục tiêu thủ công. TETR.IO phòng tùy chỉnh có các kiểu tương tự nhưng mặc định không cho chọn tay.

### 6.2 Thưởng khi bị nhiều người nhắm

Tetris 99 cộng hàng vào mỗi đòn của người đang bị nhiều người nhắm, **trước** khi nhân huy hiệu:

| Số người đang nhắm bạn | Hàng cộng thêm mỗi lần xóa |
|---|---|
| 2 | +1 |
| 3 | +3 |
| 4 | +5 |
| 5 | +7 |
| 6+ | +9 |

Mục đích là cho người bị dồn có cơ hội lật thế. Nó sinh ra chiến thuật "mồi KO": cố ý xếp cao để hút người khác nhắm, rồi xả Single được cộng 9 hàng. Ở phòng 8 người, +9 là quá lớn so với tổng sát thương trong trận.

### 6.3 KO và huy hiệu

- **Ai được tính KO:** người gửi những hàng garbage cuối cùng làm nạn nhân thua.
- Người KO nhận 1 huy hiệu **cộng toàn bộ huy hiệu** của nạn nhân.
- Huy hiệu tăng sát thương (làm tròn xuống sau khi nhân):

| Mức | Tăng sát thương | Tổng huy hiệu cần |
|---|---|---|
| 1 | +25% | 2 |
| 2 | +50% | 6 |
| 3 | +75% | 14 |
| 4 | +100% | 30 |

Với phòng tối đa 8 người, tối đa chỉ có 7 KO, nên ngưỡng này gần như không bao giờ tới mức 3.

### 6.4 Đề xuất cho phòng 2–8 người

- Phòng 2 người: bỏ qua toàn bộ phần nhắm mục tiêu (chỉ có một đối thủ).
- Phòng 3–8 người: giữ 4 chế độ, mặc định Random, cho đổi chế độ bằng 1 chạm. Bỏ chọn tay trên điện thoại vì màn hình nhỏ.
- Thưởng bị nhiều người nhắm: **+1 khi 2 người, +2 khi từ 3 người**.
- Huy hiệu: ngưỡng **1 / 3 / 5 KO** cho **+25% / +50% / +75%**. Có trần 75% để người dẫn đầu không thành vô địch.
- Màn hình hiện rõ ai đang nhắm mình (Tetris 99 dùng đường nối màu vàng).

---

## 7. Chế độ chơi

### 7.1 Battle Royale (sinh tồn)

Người cuối cùng còn sống thắng. Tetris 99 tăng trọng lực từ khi còn 50 người, dần lên 1G (1 hàng/frame), và rút ngắn thời gian garbage vào bàn khi số người giảm. N3TWORK Royale tăng cấp mỗi 30 s.

**Đề xuất:** trọng lực và tốc độ garbage tăng theo **thời gian** (có giai đoạn chờ đầu trận), không theo số người còn lại, vì phòng nhỏ có rất ít mốc loại. Thứ hạng là thứ tự bị loại.

### 7.2 Time Attack / giới hạn thời gian

Có hai mô hình khác nhau, nên tách rõ:

| Mô hình | Cách thắng | Tiền lệ | Ghi chú |
|---|---|---|---|
| **Đếm KO có hồi sinh** | Trong 2 phút, ai KO đối thủ nhiều lần nhất thắng. Hòa thì xét số hàng đã gửi, rồi chiều cao stack | Tetris Battle Battle 2P (tối đa 5 KO/ván), Battle 6P | Không ai bị loại sớm phải ngồi xem. Rất hợp nhóm bạn và phòng ít người |
| Điểm cao nhất | Hết giờ, ai nhiều điểm nhất thắng | Tetris Effect Score Attack | Garbage chủ yếu làm phiền chứ ít quyết định kết quả |

**Đề xuất:** dùng mô hình đếm KO có hồi sinh cho Time Attack, vì nó vẫn giữ được phần "đẩy hàng để hạ đối thủ" ở trung tâm.

### 7.3 1v1 cho đấu giải

Hai người, "first to N" (TETR.IO có tham số `ft` = số ván cần thắng và `wb` = cách biệt tối thiểu). Khớp với khung Bo1/Bo3 và bracket đang có của Caro Cup, nên có thể dùng lại cách tổ chức giải.

### 7.4 Item / Sabotage

| Tiền lệ | Item |
|---|---|
| TetriNET | Thêm hàng, xóa hàng, xóa khối ngẫu nhiên, bom khối, động đất (xô lệch các hàng), trọng lực khối, **đổi bàn với mục tiêu**, xóa sạch bàn. Item nằm trên ô đặc biệt trong bàn; xóa hàng chứa ô đó thì nhận item, xóa nhiều hàng thì nhận nhiều item |
| Tetris Battle | Khiên (chặn tối đa 15 hàng), Final Rush (gửi thêm tối đa 15 hàng trong 30 s cuối), Twin Bomb (2 bom mỗi hàng), 1 KO. Phải mua trước trận; một phần cộng đồng coi là gian lận |

Đánh giá ba skill trong ý tưởng:

| Skill | Rủi ro | Đề xuất |
|---|---|---|
| Làm mờ màn hình đối thủ 3 s | Trên điện thoại gần như là "chết chắc" nếu đúng lúc stack cao | Làm mờ một phần (chỉ vùng Next hoặc nửa trên bàn), kèm báo trước 1 s |
| Đảo trái/phải | Với điều khiển vuốt, người chơi không phản xạ lại kịp | Thời lượng ngắn (khoảng 5 s), có biểu tượng rõ trên màn hình |
| Khóa xoay | Không xoay được thì nhiều khối không đặt được chỗ nào | Thay bằng "chỉ xoay một chiều" hoặc "ẩn bóng khối (ghost)" |

**Đề xuất chung:** item là một chế độ riêng ("Chaos"), không trộn vào chế độ xếp hạng hay giải đấu. Lấy item theo kiểu TetriNET (ô đặc biệt trong bàn) hoặc từ thanh năng lượng nạp bằng Single. Mỗi item gây khó chịu có cooldown và bộ đếm giới hạn số lần một người bị dính liên tiếp.

---

## 8. Chống kéo dài trận (anti-stall)

Không có cơ chế này, hai người chơi giỏi có thể counter nhau mãi.

| Cơ chế | Game |
|---|---|
| Hệ số garbage tăng theo thời gian sau một khoảng chờ | TETR.IO: "garbage margin time" mặc định 30 s, rồi hệ số tăng đều mỗi giây |
| Trọng lực tăng theo thời gian | Tetris 99, TETR.IO ("gravity margin time") |
| Thêm garbage vĩnh viễn và tăng sát thương nhận vào theo phút | TETR.IO Quick Play: 8 phút thêm 2 hàng vĩnh viễn, 9 phút nhận thêm 25%, rồi tăng tiếp |
| Garbage không xóa được | Jstris, NullpoMino |
| Hết giờ, xét theo chỉ số | Tetris Battle |

**Đề xuất:** từ phút thứ 2, hệ số garbage tăng dần, cộng thêm trọng lực tăng. Time Attack có đồng hồ cứng nên không cần thêm gì.

---

## 9. Điều khiển trên Telegram Mini App

- **Vuốt là chuẩn của bản mobile chính thức.** Tetris của N3TWORK/PlayStudios: vuốt trái/phải để di chuyển, chạm nửa phải xoay theo chiều kim đồng hồ, chạm nửa trái xoay ngược, vuốt xuống thả thẳng (hard drop), giữ rồi kéo xuống để rơi chậm (soft drop), vuốt lên để hold. Bản này từng có nút ảo nhưng đã **bỏ ở phiên bản 5.7.2**.
- **Phàn nàn chính về vuốt:** phải nhấc tay rồi vuốt mạnh mới hard drop; vuốt nhẹ không nhận. Trong đấu tốc độ, đây là điểm làm người chơi bỏ game.
- **Ở Telegram, vuốt dọc dễ đóng Mini App.** App đã gọi `disableVerticalSwipes()` trong `src/client/telegram.ts`, nhưng client Telegram cũ không hỗ trợ (log dev đã có cảnh báo "not supported in version 6.0"). Trên máy đó, vuốt xuống để hard drop có thể kéo đóng Mini App.

**Đề xuất:** mặc định dùng **nút ảo** (trái, phải, xoay trái, xoay phải, hard drop, hold), vuốt là tùy chọn. Rung nhẹ (Telegram `HapticFeedback`) khi khóa khối và khi bị garbage vào bàn. Bàn chơi phải vừa cùng lúc với cụm nút trên màn hình dọc.

---

## 10. Kiến trúc mạng

### 10.1 Hiện trạng

Theo `src/server/realtime.ts`: Ably chỉ là "chuông cửa". Sau khi ghi Mongo thành công, server publish `{ v: version }` qua Ably REST. Client chỉ có quyền **subscribe** (`caro:*`, `sudoku:*`), nhận tín hiệu rồi gọi lại API để lấy state. Mọi luật chạy trên server, trong request Vercel.

Mô hình đó ổn cho Caro (vài giây một nước) và Sudoku (vài giây một ô). Game xếp khối thì khác:
- Mỗi người đặt khoảng 1–3 khối mỗi giây. Phòng 8 người là 8–24 sự kiện mỗi giây.
- Đòn tấn công cần tới người nhận trong khoảng 100–200 ms để counter còn ý nghĩa.
- Đi vòng "client gửi API, Vercel ghi Mongo, rồi Ably báo, rồi client gọi API đọc lại" tốn vài trăm ms mỗi lượt. Thêm nữa, 8 người cùng ghi vào một document phòng sẽ va nhau liên tục trong vòng compare-and-swap.

### 10.2 Các phương án

| Phương án | Mô tả | Ưu | Nhược |
|---|---|---|---|
| **A. Client publish thẳng lên Ably** | Server cấp token cho phép `publish` + `subscribe` trên kênh riêng của phòng. Mỗi client tự chạy engine của mình và phát sự kiện (đặt khối, gửi đòn, snapshot bàn, thua). Server chỉ lo lobby, seed, và ghi kết quả cuối | Độ trễ thấp (Ably công bố median toàn cầu 37 ms), không cần server game riêng, khớp hạ tầng đang có | Client tự quyết bảng của mình nên có thể gian lận; cần kiểm bằng replay nếu muốn xếp hạng |
| B. Mọi sự kiện đi qua API Vercel | Client POST mỗi lần đặt khối, server kiểm luật rồi publish | Server là nguồn sự thật | Chậm, ghi Mongo dày đặc, chi phí lời gọi hàm cao. Không hợp thể loại này |
| C. Server WebSocket riêng có quyền quyết định | Một service (Fly.io, Railway, …) giữ state trận và chạy engine | Chống gian lận tốt nhất, là cách TETR.IO làm | Phải vận hành thêm một service. WebSocket native của Vercel (beta từ 22/06/2026) bám một instance, không có fan-out và có giới hạn thời lượng kết nối, nên không thay thế được |

**Khuyến nghị: phương án A** cho bản đầu, nhắm tới nhóm bạn trong Telegram. Nâng lên C chỉ khi có xếp hạng công khai hoặc giải có thưởng.

### 10.3 Thiết kế sự kiện cho phương án A

- Server tạo `seed` lúc START. Mọi client sinh cùng chuỗi 7-bag từ seed đó.
- Mỗi client phát:
  - `lock`: số thứ tự khối, thời điểm, kiểu xóa hàng, số hàng gửi, mục tiêu, **snapshot bàn** nén gọn (10×20 ô, mỗi ô 1 bit "có/không" là 25 byte, kèm chiều cao cột).
  - `topout`: kèm id người gửi những hàng garbage cuối cùng, để tính KO.
- **Người nhận tự xử lý hàng chờ của mình:** khi nhận đòn, họ đưa vào hàng chờ cục bộ; counter trừ vào đó. Không ai sửa bảng của người khác, nên không có xung đột ghi.
- Ably đảm bảo thứ tự **theo từng người publish**, không đảm bảo thứ tự giữa các người khác nhau. Hai đòn bay ngược chiều cùng lúc sẽ thành passthrough (mục 4.5); chấp nhận và nói rõ trong luật.
- Mất kết nối ngắn: Ably tự phát lại message bị lỡ trong tối đa 2 phút. Lâu hơn thì coi như thua, giống luật reconnect của Caro.
- Kết quả cuối (thứ hạng, KO) do client gửi về API. Server đối chiếu: thứ tự `topout` nhận qua Ably phải khớp với thứ hạng client khai.

### 10.4 Ngân sách message trên Ably (gói Free)

Giới hạn gói Free: **6.000.000 message/tháng**, **500 message/giây cho cả tài khoản**, 50 message/giây publish trên mỗi kênh, 500 kết nối đồng thời. Mỗi lần publish tính 1 message vào, **mỗi người nhận tính thêm 1**; echo (người gửi tự nhận lại) bật mặc định và cũng tính. Message trên 5 KiB tính thành nhiều message.

| Kịch bản (phòng 8 người) | Message/giây | Ghi chú |
|---|---|---|
| Snapshot riêng 6 lần/giây (nhịp Tetris 99) + echo bật | 8×6 vào + 8×6×8 ra ≈ **432** | Một phòng đã gần chạm trần 500/giây của **cả tài khoản** |
| Snapshot gộp vào sự kiện `lock` (khoảng 1,5 khối/giây/người), tắt echo | 8×1,5 vào + 8×1,5×7 ra ≈ **96** | Khoảng 5 phòng 8 người chạy cùng lúc |

Với kịch bản thứ hai, một trận 3 phút tốn khoảng 17.000 message, tức khoảng **350 trận 8 người mỗi tháng** trên gói Free. Phòng 2 người tốn khoảng 6 message/giây, khoảng 1.100 message mỗi trận 3 phút.

**Đề xuất:** gộp snapshot vào `lock`, tắt echo, giới hạn tối đa 3 sự kiện/giây/người. Nếu cần đông hơn, chuyển gói trả phí của Ably.

### 10.5 Chống gian lận

- TETR.IO dùng **cùng một engine cho client và server**: server chạy lại thao tác của người chơi, sai một chi tiết là bị loại. Họ còn phát hiện bất thường qua nhịp thời gian trong replay (ví dụ nhịp gõ không khớp tần số quét của bàn phím).
- Jstris lưu replay là **seed + danh sách (thời điểm, mã thao tác)**, mỗi thao tác 16 bit (12 bit thời gian, 4 bit mã), nén bằng lz-string.

**Đề xuất:** viết engine trong `src/` dạng thuần TypeScript, xác định, dùng chung cho client và server (giống cách `src/game/rules.ts` của Caro đang dùng chung). Bản đầu chỉ ghi log thao tác. Khi cần, server phát lại log để kiểm tra kết quả của các trận giải đấu.

---

## 11. Tên gọi và pháp lý

- **"Tetris" là nhãn hiệu.** Bộ Guideline còn yêu cầu game được cấp phép phải có tên bắt đầu bằng "Tetris"; nghĩa là chữ này dành cho bên có giấy phép.
- **Phán quyết Tetris Holding v. Xio Interactive (Tòa liên bang New Jersey, 2012):** luật chơi và ý tưởng "khối rơi" không được bảo hộ. Nhưng **cách thể hiện** thì được: khối 4 ô có viền từng ô, màu sáng đặc trưng, bàn chơi hình chữ nhật đứng cao hơn rộng, kiểu khối rơi, xoay và đổi hình khi khóa. Game Mino bị xử thua vì gần như không phân biệt được với Tetris.
- **"Tetris Royale" là tên một game thật** của N3TWORK (chế độ battle royale tới 100 người, sau được gộp vào app Tetris chính thức).

**Đề xuất:**
- Đặt tên riêng, không chứa "Tetris" (đặt dưới thương hiệu chung "Game Cup").
- Không dùng tên "Tetrimino", và không dùng bảng màu chuẩn của Guideline (I xanh lơ, O vàng, T tím, …).
- Tạo phong cách hình ảnh riêng thay vì khối viền nổi kiểu Tetris.
- Phần này không phải tư vấn pháp lý. Nếu có kế hoạch kiếm tiền, nên hỏi luật sư.

---

## 12. Câu hỏi owner cần chốt

1. **Tên game** (mục 11).
2. **Số người mỗi phòng:** 2–8 như ý tưởng, hay giới hạn nhỏ hơn cho bản đầu?
3. **Chế độ trong bản đầu:** đề xuất **Battle Royale + 1v1 Bo1/Bo3**, để Time Attack (đếm KO) và Item sang bản sau.
4. **T-Spin:** có thưởng không? (Đề xuất: có.)
5. **"Gạch khóa":** bỏ, hay chỉ có trong chế độ Item? (Đề xuất: chỉ trong Item, dùng biến thể garbage đặc.)
6. **Điều khiển mặc định:** nút ảo hay vuốt? (Đề xuất: nút ảo.)
7. **Mức chống gian lận:** chấp nhận "client tự quyết" cho nhóm bạn, hay cần server kiểm replay ngay từ đầu?
8. **Ngân sách realtime:** ở gói Ably Free (khoảng 350 trận 8 người/tháng) hay nâng gói?

---

## 13. Nguồn

- TetrisWiki, Garbage: https://tetris.wiki/Garbage
- TetrisWiki, Combo: https://tetris.wiki/Combo
- TetrisWiki, Tetris Guideline: https://tetris.wiki/Tetris_Guideline
- TetrisWiki, Tetris 99: https://tetris.wiki/Tetris_99
- TetrisWiki, TETR.IO: https://www.tetris.wiki/TETR.IO
- TetrisWiki, Tetris Battle (Facebook): https://tetris.wiki/Tetris_Battle_(Facebook)
- TetrisWiki, Tetris Effect: https://tetris.wiki/Tetris_Effect
- TetrisWiki, Tetris (2020 mobile game): https://tetris.wiki/Tetris_(N3TWORK)
- Hard Drop, Garbage: https://harddrop.com/wiki/Garbage
- Hard Drop, Tetris 99: https://harddrop.com/wiki/Tetris_99
- Hard Drop, Multiplayer Techniques: https://harddrop.com/wiki/Multiplayer_Techniques
- Hard Drop, Tetris Battle: https://harddrop.com/wiki/Tetris_Battle
- Hard Drop, TetriNET: https://harddrop.com/wiki/Tetrinet
- TETR.IO wiki, Mechanics: https://tetrio.wiki.gg/wiki/Mechanics
- Cấu hình phòng TETR.IO (tài liệu cộng đồng): https://github.com/Poyo-SSB/tetrio-bot-docs/blob/master/Room_Config.md
- Tetris Design Guideline 2009 (bản lưu trữ): https://archive.org/details/2009-tetris-variant-concepts_202201
- osk, TETR.IO Forty-Four Fact Frenzy (anti-cheat): https://blog.osk.sh/post.php?p=5df9463f716867.05060790
- Jstris, định dạng replay (diễn đàn Hard Drop): https://harddrop.com/forums/index.php?topic=7087.135
- Tetris Mobile, hướng dẫn điều khiển: https://playstudios.helpshift.com/hc/en/16-tetris-mobile/faq/2953-tetris-controls/
- Ably, giới hạn: https://ably.com/docs/platform/pricing/limits
- Ably, cách đếm message: https://ably.com/docs/platform/pricing/message-counting
- Ably, latency: https://ably.com/docs/platform/architecture/latency
- Ably, WebSockets trên Vercel: https://ably.com/vercel/websockets-on-vercel
- Tetris Holding v. Xio Interactive, ý kiến tòa án: https://www.govinfo.gov/content/pkg/USCOURTS-njd-3_09-cv-06115/pdf/USCOURTS-njd-3_09-cv-06115-0.pdf
