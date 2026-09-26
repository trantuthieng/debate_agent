# Nhật ký triển khai — Debate Agent

Ghi lại toàn bộ quá trình phát triển, kiểm thử thực tế (real-model smoke test) và các vấn đề còn tồn đọng. Cập nhật lần cuối: 2026-09-11.

## 1. Mục tiêu dự án (theo CLAUDE.MD)

Xây 1 VS Code extension chạy hoàn toàn bằng model local (Ollama, tối ưu cho Mac mini M4 24GB RAM): người dùng ra 1 câu lệnh, hệ thống tự tạo agent, tự nghiên cứu, tự tranh luận (≥5 model khác nhau, ≥3 vòng: đề xuất → phản biện chéo → phản hồi → chấm điểm chọn phương án), tự code, tự kiểm tra chéo, tự giao sản phẩm hoàn chỉnh — người dùng can thiệp tối thiểu (ví dụ chỉ cung cấp API key khi cần).

## 2. Lịch sử commit chính

| Commit | Nội dung |
|---|---|
| `067469b` | Khởi tạo extension |
| `1276e0d`, `a0f6d6d`, `4d2a06a` | README, v1.0.0, v1.0.1 |
| `6d08c80` | Chuẩn bị push lên git |
| `4ab45c3` | Debate panel, research có kiểm soát, bỏ generator cũ |
| `0d44f85` | Agent-tạo-agent (dynamic agent spawning) |
| `103ea3d` | Khép kín vòng lặp: tự thiết kế mục tiêu → tranh luận → build |
| `a058312` | Robustness từ black-box run: capability gate, dependency gating, scope, verification |
| `fee697b` | Build tool hoàn chỉnh khi CV/credentials là input lúc chạy, không phải blocker lúc build |
| `54e2ee9` | 1 phản hồi model lỗi không còn giết cả run (coerce uncertainties + resilience guard per-task) |
| `5a37c81` | 1 diff lỗi không còn xóa mất toàn bộ file tốt của task |

Nhánh hiện tại `feat/debate-hardening-research-cleanup` có rất nhiều thay đổi **chưa commit** (xem `git status`) — chủ yếu là các lớp mới: `connectors/`, `modelReadinessService`, `systemResourceService`, `assetLibraryService`, `verificationPlanner`, `moduleContracts`, `retry` utils.

## 3. Các đợt smoke-test thực tế (model thật, không mock) — tóm tắt từ memory

Chạy pipeline `runAutonomousGoal()` thật nhiều lần với đề bài "xây game brick breaker 20 level" để kiểm tra chất lượng đầu ra thực tế (không phải unit test). Đã phát hiện và sửa:

1. **Thiếu `module.exports`** — reviewer + quality-auditor LLM đều duyệt "production-ready" dù file test `require()` 6 hàm không tồn tại. → Thêm static check tất định (`moduleContracts.ts`), không phụ thuộc phán đoán của model.
2. **OOM do RAM thật thấp** (Edge dùng ~3.7GB, máy chỉ còn 2.5% free) — không phải bug app.
3. **Hallucination ở bước retrospective**: 3 agent đồng thuận "20/20 level chạy tốt, 60fps, ARIA..." trong khi thực tế chỉ có 2/20 level và JSON lỗi cú pháp — vì bước đó chỉ được cho xem *đường dẫn file*, không phải *nội dung*. → Cho agent xem nội dung file thật + thêm lớp quét tất định sau cùng, override "done" nếu vẫn còn lỗi cụ thể.
4–5. **1 patch lỗi (diff không áp dụng được) làm abort cả run** thay vì retry — cùng loại bug lặp lại ở nhiều điểm trong vòng lặp test-fix của `_phaseTesting`. Đã sửa 3 điểm, audit toàn bộ `throw new WorkflowError` trong `AgentOrchestrator.ts` (6 điểm, 2 điểm cùng loại đã sửa, 4 điểm còn lại là hard-stop hợp lệ).
6. Run bị kill do session Claude Code restart giữa chừng — không phải bug app; rút kinh nghiệm chạy `nohup ... & disown`.
7. **Ollama crash SIGBUS thật** (`dequantize_row_q4_K`, llama.cpp/GGML) khi load `qwen3-coder:30b` — nâng cấp Ollama 0.33.3 → 0.34.0 (tưởng đã sửa, **thực ra chưa** — xem mục 4).
8. Ổ chứa model (`/Volumes/Data/LLM_model`, 96GB) là ổ USB ngoài; macOS có `disksleep=10` (ổ tự ngủ) — nghi ngờ là 1 nguyên nhân góp phần gây SIGBUS.
9. Run hoàn thành trọn vẹn lần đầu (~1h54m) sau các fix trên.
10. **Toolchain-discovery bug**: dự án browser game (Phaser/JS) bị tự động tiêm ràng buộc "phải dùng Swift/`swift test`" chỉ vì máy có cài Swift CLI — đốt hết 8 lần fix vào 1 vấn đề tự tạo ra. → Ràng buộc giờ chỉ áp dụng khi chính brief của dự án nhắm nền tảng Apple.
11. User cho phép chạy tự động hoàn toàn, chỉ báo khi xong hoặc cần quyết định thật.
12. **Root cause SIGBUS xác định chính xác**: luôn xảy ra khi load `qwen3-coder:30b` (18GB, MoE) — do đọc mmap 1 file lớn qua USB kém ổn định hơn NVMe nội bộ, cộng với lúc đó ổ trong chỉ còn 14GB trống (không đủ để relocate). → Mitigation tạm: đổi `qwen3-coder:30b` → `devstral-small-2` trong **script test** (`run_brick_breaker_20.js`), **chưa sửa trong code chính thức**.

## 4. Phiên làm việc hôm nay (2026-09-11)

- **Xác nhận SIGBUS tái diễn 2 lần nữa** (10/9 18:32 và 11/9 08:26) ngay cả trên Ollama 0.34.0 → kết luận "đã sửa" ở mục 3.7 là **sai**, vấn đề vẫn còn sống. Vẫn là `qwen3-coder:30b`, vẫn lúc load qua USB.
- Xác nhận `AgentWorkspace.ts:125` (code chính thức, không phải script test) **vẫn** đặt `qwen3-coder:30b` làm model chính cho vai `brainstorm` + fallback ở 5 vai khác.
- Ổ trong đã có **82-85GB trống** (tăng từ 14GB) — không còn "hết chỗ" tuyệt đối, nhưng vẫn thiếu ~14-20GB so với full 96GB model archive.
- Đã bàn phương án "stage model từ Data vào ổ trong theo phiên chạy, xóa khi xong" — **đã hoãn theo yêu cầu user**, chưa build.
- **Áp dụng `sudo pmset -a disksleep 0`** (xác nhận đã set). Test trực tiếp gọi `qwen3-coder:30b` sau khi 1 run thật (run 9) kết thúc: **thành công, không crash** (nhưng mới 1 lần thử — SIGBUS trước đây cũng không phải lần nào cũng crash, nên **chưa đủ để kết luận chắc chắn đã hết bug**).
- **Run 9 (goal: brick breaker 20 level) thực ra ĐÃ LỖI**, không phải hoàn thành như báo cáo ban đầu (đã đính chính với user): dừng ngay sau Sprint 1 (5 task, chỉ có 1/20 level) vì `npm install` xung đột ERESOLVE — `package.json` do model sinh ra ghi `@babel/core: "^8.0.5"` (Babel 8) nhưng `ts-jest` chỉ hỗ trợ Babel 7. `_phaseDependencyInstall` không có retry nên abort ngay lần lỗi đầu tiên (đúng lỗ hổng đã cảnh báo trước đó ở mục 3.5, giờ xảy ra thật).
- **Phát hiện thêm 3 bug khiến output của run 9 không chạy được** (dù reviewer/quality-auditor đã duyệt "pass"): thiếu file entry point (`webpack.config.js` trỏ `./src/index.ts` nhưng file không tồn tại); `config.js` dùng `Phaser.AUTO` mà không `import Phaser`, khai báo scene bằng chuỗi thay vì class; `public/index.html` trỏ sai đường dẫn bundle so với cấu hình `devServer`. Đã sửa 3 lỗi này **chỉ trong workspace tạm** (`/var/folders/.../brick20-agent-P8W8Tf`) để user xem thử trên `localhost:8080` — **chưa sửa gì trong code chính thức của extension**.

## 5. Vấn đề còn tồn đọng (ưu tiên cao → thấp)

> Danh sách tại thời điểm ghi nhận ban đầu. Tiến độ sửa tiếp theo được cập nhật ở mục 7.

1. **`_phaseDependencyInstall` không có retry/self-heal** (`AgentOrchestrator.ts`) — 1 xung đột `npm install`/`pip install` là abort toàn bộ run, mất hết công sức đã làm trước đó. Vừa gây fail thật ở run 9. Chưa sửa.
2. **Không có bước verify "app thực sự chạy được" cho dự án web/game** — reviewer + quality-auditor chỉ đọc code tĩnh, không ai chạy `npm start`/`webpack build` để bắt lỗi wiring (thiếu entry point, sai cấu hình Phaser, sai đường dẫn static). Run 9 "pass" hết review nhưng không mở được trên trình duyệt. Đây là lỗ hổng mới phát hiện hôm nay, cùng họ với vấn đề đã từng thấy ở mục 3.1/3.3 (LLM duyệt mà không có bằng chứng thật) — chưa sửa.
3. **`qwen3-coder:30b` vẫn là model chính thức cho `brainstorm`** trong `AgentWorkspace.ts` dù lịch sử crash SIGBUS nhiều lần; fix `disksleep=0` mới validate 1 lần. Cần thêm vài lần gọi thật không crash mới đủ tin cậy, hoặc cân nhắc đổi default hẳn sang `devstral-small-2` như đã làm trong script test.
4. **Chưa có bản game 20 level nào hoàn chỉnh** — mọi lần chạy đều dừng giữa chừng (thiếu dependency retry, hoặc lỗi khác). Cần 1 lần chạy trọn vẹn để xác nhận toàn bộ chuỗi fix đến nay hoạt động đúng với nhau.
5. **Thiết kế "stage model Data → ổ trong theo phiên, xóa khi xong"** — đã bàn, đã hoãn, chưa build. Cần quay lại nếu disksleep fix không đủ.
6. Nhánh hiện tại có rất nhiều file chưa commit (xem mục 2) — rủi ro mất việc nếu không commit định kỳ.
7. (nhẹ) 2 lỗi "fetch failed" thoáng qua trong log run 9 (tự phục hồi nhờ retry có sẵn) — chưa rõ nguyên nhân, chưa cần điều tra gấp.

## 6. Đề xuất bước tiếp theo

- Ưu tiên sửa mục 5.1 (dependency-install retry) trước — đang là nguyên nhân trực tiếp gây fail run gần nhất.
- Thêm 1 bước verify thật (chạy `npm start`/build + kiểm tra không lỗi compile) cho dự án loại web/game trước khi coi task "reviewed" — giải quyết mục 5.2.
- Sau 2 fix trên, chạy lại full run để lần đầu có 1 bản game 20-level hoàn chỉnh, đồng thời quan sát thêm `qwen3-coder:30b` có còn crash không.

## 7. Đợt hardening và benchmark tiếp theo — 2026-09-11

Mục tiêu: người dùng nhập một prompt; các model local tranh luận nhiều vòng, tạo sản phẩm, tự sửa và kiểm tra thực tế. Chưa có bằng chứng để khẳng định chất lượng tương đương ChatGPT Astra Ultra.

### Các sửa đổi đã triển khai

- Dependency install có retry/self-heal theo `maxFixRetries`: gửi lỗi thật và manifest hiện tại cho fixer, kiểm tra patch trước khi áp dụng, chạy install lại rồi mới chấp nhận. Không dùng `--force`/`--legacy-peer-deps` để che lỗi. Test-fix đổi manifest phải cài lại dependency.
- Kiểm tra web bằng trình duyệt Chromium/Edge thật: bắt lỗi JavaScript, thiếu resource, bundle URL trả HTML, server không khởi động; lưu screenshot. Webpack/Vite thiếu script build vẫn được build bằng CLI đã có trong sản phẩm. Hỗ trợ HTML tĩnh không cần package.json.
- Server smoke dùng cổng riêng và dừng cả process group thuộc phiên, tránh kiểm tra nhầm server cũ.
- Default bỏ `qwen3-coder:30b`; không tự chọn lại model này làm reserve/fallback từ inventory. Embedding model và alias cùng digest không được tính là model tranh luận độc lập.
- Đo thực tế máy hiện tại có **32 GiB RAM**, khác giả định 24 GB trong nhật ký cũ. Client giới hạn context theo metadata/model weights/KV cache/RAM, giải phóng model trước khi đổi lượt, tuần tự hóa các yêu cầu generation. Không tự đóng app khác; `targetFreeGb` mặc định 0, vẫn giữ memory-pressure guard.
- `maxDevelopmentSprints` tách khỏi số vòng debate. Hết sprint nhưng còn việc hoặc task thất bại không được báo completed. Lưu checkpoint từng bước; Resume hỗ trợ trạng thái failed và giữ nguyên code đã tạo.
- Product template recovery chuyển thành opt-in (`selfHealing.allowProductTemplates: false` mặc định), để game mẫu viết sẵn không thay thế kết quả sinh code khi đánh giá agent.
- Sửa nhận diện từ “resume”: pause/resume trong game không còn bị suy diễn thành yêu cầu CV xin việc.
- Thêm benchmark chạy thật `npm run test:e2e:brick-breaker`, dùng default config và `runAutonomousGoal()`, lưu game vào demo riêng cùng transcript, log và báo cáo JSON.

### Bằng chứng và tiến độ

- `npm run check:release` trước tích hợp quantity/HTTP mới: **204/204 pass**. Sau tích hợp: compile/lint sạch, **227/227 test pass**; Extension Host smoke test đã pass cả 9 lệnh. Các bài browser/localhost phải chạy ngoài sandbox; lỗi EPERM trong sandbox không phải lỗi ứng dụng.
- Kiểm tra Edge thật đã xác nhận `ReferenceError: Phaser is not defined` bị chặn; trang canvas hợp lệ pass và có screenshot. Đây là bằng chứng khởi động, chưa chứng minh gameplay đủ 20 màn.
- Lượt benchmark sơ bộ `demo/brick-breaker-20-2026-09-11T05-54-02-393Z`: **5 model qua readiness**, chủ động dừng sau khi phát hiện false-positive CV từ “pause/resume” và lỗi Stop trong fallback; chưa sinh sản phẩm hoàn chỉnh. Không tính lượt này là thành công.
- Lượt `demo/brick-breaker-20-2026-09-11T06-31-46-637Z` bị ngắt HTTP sau **301008 ms** ở meta-agent dù timeout cấu hình 600000 ms. Ollama vẫn sinh token bình thường. Đã sửa transport từ native fetch/Undici (header timeout mặc định 300s) sang Node http/https với deadline đầy đủ; thêm test delayed-headers/body và Stop. Chủ động dừng lượt này để áp dụng fix; Stop lần này thoát đúng.
- Tích hợp `CollectionAcceptanceService`: yêu cầu số lượng từ prompt được đối chiếu với JSON array hoặc module export thật qua `acceptance.json`; thiếu nguồn kiểm chứng hoặc sai số lượng sẽ kích hoạt fixer. Sparse array/đếm tự khai báo không được cho qua. Số lượng đủ chưa tự chứng minh gameplay đúng.
- Lượt `demo/brick-breaker-20-2026-09-11T06-46-03-244Z`, log `/private/tmp/debate-brick20-verified.log`: **thất bại sau 102 phút**, đã hoàn tất 4 vòng debate, brief và architecture, nhưng 0/5 task hoàn thành. Model tạo `src/assets/images`, `src/assets/sounds`, `tests/unit`, `tests/e2e` thành file rỗng dù mô tả là directory; heuristic chặn, 2 lượt fix không tiến triển, 4 task phụ thuộc bị skip. Product templates tắt; không có game hoàn chỉnh, browser/count gate chưa được chạy. Toàn bộ 46 model call không lỗi transport, trong đó architecture có call dài hơn 5 phút. Báo cáo lưu SHA-256 implementation đã chạy.
- Chưa triển khai staging model USB → SSD nội bộ; giữ nguyên quyết định hoãn trước đó. Không kết luận nguyên nhân SIGBUS đã được chữa khỏi.

- Gói `dist/local-multi-agent-coder-1.0.1.vsix` đã build với code mới (112 files, khoảng 299 KB) và cài thử thành công vào profile VS Code tạm (`npm run test:vsix`). Chưa coi việc đóng gói extension là benchmark game thành công.

### Tiếp tục sau lượt 102 phút

- Sửa directory scaffold: mô tả directory rõ ràng + nội dung rỗng được chuẩn hóa thành đường dẫn có `/`; structural review phân biệt directory với file nguồn rỗng. Có thể phục hồi file 0 byte cũ thành directory; không ghi đè file có dữ liệu hoặc symlink. 3 regression test đạt.
- Audit debate phát hiện scorecard thiếu phương án/tiêu chí vẫn được tính, Round 4 chưa đọc lịch sử R1/R2, reserve rỗng vẫn bị báo đã phá hòa. Đã sửa strict scorecard, retry đúng model, context đủ 3 vòng có giới hạn và báo hòa trung thực; 28 dynamic tests đạt. Lượt cũ có 40 judge votes thay vì 42 phiếu đầy đủ dự kiến khi có reserve, nên không dùng nó làm bằng chứng cho gate chấm điểm mới.
- Đang tích hợp Resume lưu đúng chế độ autonomous, khôi phục task failed/skipped và kiểm tra lại khi tiếp tục sau retrospective; cùng chính sách chuyển thiếu số lượng nội dung của một slice chạy được sang sprint sau. Không hạ tiêu chí đủ 20 màn ở lần giao cuối.
- Benchmark harness lưu báo cáo riêng từng invocation và liên kết báo cáo trước Resume, để phân biệt version sinh debate cũ và version chạy tiếp build. Không chỉnh game bằng tay hoặc dùng game mẫu thay cho model.

### 2026-09-12 — Resume benchmark

- Các sửa Resume, directory, strict scorecard, deadline HTTP và chuyển thiếu nội dung sang sprint tiếp đã tích hợp; **252/252 tests pass** (`/private/tmp/debate-tests-sept12.log`). Test output-limit dùng ghi đồng bộ để đo giới hạn output, tránh tự tạo hàng đợi gây OOM trước khi parent nhận dữ liệu.
- Đã chạy public Resume lúc 06:31 ngày 12/9 (giờ Việt Nam), cùng workspace `demo/brick-breaker-20-2026-09-11T06-46-03-244Z`; log `/private/tmp/debate-brick20-resume-sept12.log`. Xác nhận bắt đầu tại coding task `sprint-01-task-001`, không chạy lại debate, các task skip đã trở lại pending.
- Trạng thái hiện tại: đang chạy; chưa có bằng chứng game hoàn chỉnh hoặc đủ gameplay 20 màn.
- VS Code Extension Host đạt 9 lệnh; gói `dist/local-multi-agent-coder-1.0.1.vsix` đã đóng gói lại (112 files, 303.62 KB) và cài thử thành công. Parser replay đã kiểm chứng đủ 6 phản hồi ở từng vòng R1–R3 từ transcript cũ, chưa gọi model để replay chấm điểm; ưu tiên hoàn tất lượt build đang chạy trước.
- Resume 06:31 dừng sau khoảng 4 phút 30 giây vì code worker trả `files: []` khi các file cũ đã có, nhánh coding coi đó là thất bại ngay. Đã sửa: nếu toàn bộ đường dẫn task tồn tại và có nội dung thật, tạo snapshot chỉ đọc để đi qua reviewer/fixer bình thường; không tự ghi lại file hoặc tự duyệt. Thiếu file/hoàn toàn rỗng vẫn fail. Regression xác nhận reviewer từ chối vẫn chặn task. Đã Resume tiếp, log `/private/tmp/debate-brick20-resume-noop.log`; VSIX cần rebuild sau sửa mới này.
- Lượt Resume tiếp đã hoàn thành 5 task code, sửa đúng directory và cài dependency, nhưng **thất bại tại testing sau 8 lượt fix** lúc 09:07 ngày 12/9. Còn import sai từ `tests/unit`, binding root object thay vì `/levels`, và smoke test gọi IPv4 khi Vite dùng localhost IPv6. Game chưa chơi được; dữ liệu 20 level chỉ có một brick mỗi màn, nhiều brick ngoài khung chơi.
- Sửa ngày 12/9: smoke dùng đúng host loopback được server công bố trên đúng cổng phiên; thêm HTTP Accept để Vite không trả 404 giả. Kiểm tra thật đã vào được game và bắt `TypeError ... reading 'sys'` từ scene registration Phaser — không còn che bởi lỗi kết nối.
- Diagnostic bundle tính đúng đường dẫn import từ thư mục file nhập và gợi ý JSON Pointer tới array thật. Test-fixer nhận phản hồi lần sửa trước, yêu cầu full content, ưu tiên file lỗi trong context 32k ký tự và chuyển model dự phòng từ lần thứ 3. Sửa `patch: null` bị ép thành chuỗi `"null"`, khiến full-content repair trước đó bị hiểu sai thành diff.
- Hồi quy **259/259 pass**, sau sửa HTTP Accept có **34/34 focused tests pass**. Chưa sửa game bằng tay; bước tiếp theo là Resume tại testing với diagnostic mới, rồi đánh giá gameplay độc lập. VSIX cần build lại với nhóm sửa này.
- Đã Resume testing lúc 11:47 ngày 12/9, log `/private/tmp/debate-brick20-resume-diagnostics.log`; hiện đang gọi fixer. Lưu review độc lập trước sửa tại `.agent-workspace/logs/independent-gameplay-review.json` (level 11–20 có brick ngoài viewport) và nhắc kiểm tra lại trong rolling memory; đây là phản hồi QA cho agent, không phải sửa code game bằng tay.
- Fix attempt 1 của lượt 11:47 đã sửa đúng import `../../src/utils/levelManager.js` và pointer `/levels` bằng model thật. Startup vẫn lỗi Phaser; screenshot là màn hình đen. Đang tiếp tục repair, không coi count 20 là game hoàn chỉnh. VSIX đã đóng gói lại và install smoke pass với toàn bộ nhóm sửa diagnostic/HTTP/patch-null.
- Lượt Resume 11:47 cuối cùng vẫn **fail** sau 8/8 fix attempt (kết thúc 12:27 ngày 12/9, `npm test, app smoke verification` vẫn không qua). Đã kiểm tra trực tiếp `test_result.log` + `browser-smoke.png` của lượt đó: màn hình đen do `src/utils/levelManager.js` dùng `require('fs')`/`require('path')`/`__dirname` (CommonJS) bị load thẳng trong trình duyệt → `ReferenceError: require is not defined`.

### 2026-09-12 — Sửa tay workspace `demo/brick-breaker-20-2026-09-11T06-46-03-244Z` để xác nhận chạy được (theo yêu cầu user, không phải model tự sửa)

Không đợi lượt Resume tiếp theo của pipeline; sửa trực tiếp để xác nhận toàn bộ chuỗi lỗi và có bằng chứng game chạy thật. Các lỗi phát hiện và đã sửa:

1. `levelManager.js`: bỏ `require('fs')`/`require('path')`/`__dirname`, dùng `import levels from '../levels.json'` (Vite hỗ trợ import JSON trực tiếp).
2. `levels.json`: dữ liệu cũ chỉ có 1 brick/màn, nhiều brick nằm ngoài canvas 800×600 (tọa độ tới 1050). Sinh lại lưới brick thật cho cả 20 level (2→6 hàng × 8 cột tăng theo độ khó, brick "strong" 2 máu xuất hiện từ level 9), toàn bộ nằm trong khung hình.
3. `game.js`: cấu hình `scene: ['Boot', 'Menu', 'Game', 'GameOver', 'Victory']` dùng **chuỗi** thay vì class thật (Phaser không nhận), và có 1 class `GameScene` trùng lặp định nghĩa ngay trong file này (khác với `src/scenes/Game.js`), gắn thêm bằng `game.scene.add('Game', GameScene)` sau khi `Phaser.Game` đã khởi tạo. Đã viết lại thành bootstrap sạch: import 5 scene class thật, `scene: [Boot, Menu, Game, GameOver, Victory]`. Cũng tắt gravity (game gốc để `gravity.y: 200`, sai cho thể loại Arkanoid).
4. Thiếu hẳn `src/scenes/Victory.js` dù brief yêu cầu rõ "victory state after level 20" và code có gọi tới — đã thêm.
5. `Boot.js` load ảnh từ `src/assets/images/*.png` — thư mục `assets` không tồn tại. Thay bằng texture vẽ runtime (`Graphics.generateTexture`) cho paddle/ball/brick, không cần file ảnh ngoài.
6. Không có collider nào giữa ball/paddle/brick ở bất kỳ scene nào — game không thể chơi được dù không crash. Viết lại `src/scenes/Game.js` hoàn chỉnh: paddle/ball/bricks từ `LevelManager`, `physics.add.collider` cho ball-paddle và ball-brick, mất mạng khi bóng rơi khỏi đáy, qua màn khi hết brick, Victory sau level 20, pause (P) và restart (R).
7. `Ball.js`/`Paddle.js`/`Brick.js` kế thừa `Phaser.GameObjects.Sprite` nhưng gọi `setImmovable`/`setVelocity`/`setBounce`/`setCollideWorldBounds` — các hàm này chỉ tồn tại trên `Phaser.Physics.Arcade.Sprite`. Bug có từ đầu, chưa từng lộ ra vì trước đó không class nào thực sự được dùng. Đổi base class sang `Phaser.Physics.Arcade.Sprite`.
8. `tests/unit/levelManager.test.js` dùng `require(...)` (CommonJS) trong khi `levelManager.js` cần là ESM cho Vite — dự án không có Babel config nên Jest không tự transform được. Thêm `babel.config.cjs` + `babel-jest`/`@babel/core`/`@babel/preset-env` (chỉ ảnh hưởng lúc chạy Jest, Vite không đọc file này nên bundle trình duyệt không đổi); sửa test dùng `require(...).default` cho đúng interop của Babel.

**Đã xác nhận bằng chứng thật** (không chỉ đọc code):
- `npx vite build` production build thành công.
- `npx jest`: 2/2 test pass.
- Smoke test bằng Puppeteer thật (không phải đọc log): trang tải, đúng title "Arkanoid 20 Levels", 1 canvas, **0 lỗi JavaScript** (chỉ còn 1 dòng 404 vô hại của `favicon.ico`, đã xác minh bằng `curl`).
- Chụp màn hình liên tiếp trong lúc chơi: Score đi từ 0 → 10 → 20, số brick giảm dần, bóng di chuyển — xác nhận vật lý và va chạm hoạt động thật, không chỉ đứng yên.
- Dev server đang chạy tại `http://localhost:5183/` (nohup, disown) để user tự chơi thử trực tiếp.

**Chưa làm / còn tồn đọng sau lần sửa tay này:**
- Đây là sửa tay ngoài pipeline, **không phải bằng chứng pipeline tự động đã hết lỗi** — lần Resume tự động tiếp theo (nếu chạy) vẫn sẽ dùng code cũ trong workspace này trừ khi được resume lại sau các sửa trên, và pipeline có thể sinh ra y hệt các lỗi này ở 1 workspace/run khác trong tương lai vì gốc rễ (LLM tự viết `require()` trong file browser, tự dùng string thay vì class cho Phaser scene, quên viết collider, kế thừa sai base class Phaser) chưa được sửa ở tầng review/quality-audit của `AgentOrchestrator.ts`.
- Chưa kiểm tra bằng keyboard thật (paddle di chuyển trái/phải, pause, restart) — mới xác nhận vật lý ball/brick/score tự động qua puppeteer, chưa bấm phím thử paddle.
- Chưa chơi hết 20 level để xác nhận Victory scene thực sự kích hoạt đúng lúc.

### 2026-09-12 — Sửa gốc rễ trong code chính thức (theo yêu cầu user: "fix trong code")

Chỉ sửa được 1 trong nhiều gốc rễ liệt kê ở trên — cái có thể chặn tất định (không cần LLM phán đoán) và không rủi ro false-positive: **file mix ESM `import`/`export` với API chỉ có ở Node (`require('fs')`, `__dirname`, ...)** — đúng nguyên nhân crash của `levelManager.js` cả 2 lần bị bắt gặp (workspace tạm hôm qua và demo hôm nay).

- Thêm `findBrowserIncompatibleNodeUsage()` vào `src/utils/moduleContracts.ts` — cùng kiểu tất định như `findUnresolvedRequireImports()` đã có: quét file `.js/.jsx/.ts/.tsx/.mjs` đã đổi, nếu file có cú pháp ESM (`import`/`export`) mà cũng gọi `require('fs'|'path'|'os'|...)` hoặc dùng `__dirname`/`__filename` thì báo lỗi kèm gợi ý sửa cụ thể. Không cần biết project nhắm nền tảng nào — trộn 2 hệ module trong 1 file luôn luôn sai, nên không có rủi ro báo nhầm.
- Nối vào `_executeReviewer()` trong `AgentOrchestrator.ts` (cùng chỗ, cùng cách với check `findUnresolvedRequireImports` đã có) — chạy **luôn luôn**, không chỉ khi LLM lỗi, và ép `needsFix=true`/`approved=false` bất kể LLM reviewer nói gì.
- 5 test mới trong `test/unit/moduleContracts.test.js`, tái hiện đúng bug thật của `levelManager.js` làm ca chính; cũng test không báo nhầm cho file CJS thuần, file ESM thuần, hoặc `require()` một package thường (không phải Node builtin) cạnh `import`.
- **264/264 test pass** (toàn bộ suite, gồm cả các test do phiên khác thêm), lint sạch.

**Chưa sửa (nằm ngoài phạm vi 1 kiểm tra tất định, cần thiết kế riêng nếu làm tiếp):** Phaser scene đăng ký bằng string thay vì class, thiếu scene được code gọi tới nhưng không có file, thiếu collider giữa các object, sai base class Phaser (`GameObjects.Sprite` thay vì `Physics.Arcade.Sprite`) — các bug này đặc thù theo framework/game-logic, khó chặn bằng 1 regex tất định mà không có rủi ro báo nhầm cho project không liên quan đến Phaser. Cần cân nhắc: dựa vào bước "kiểm tra bằng trình duyệt thật" (đã có, section 7) chơi thử tương tác thay vì chỉ load trang, hoặc prompt reviewer/quality-auditor nhấn mạnh cụ thể hơn vào "mọi object có wiring va chạm/vật lý đầy đủ chưa" khi stack là 1 game engine.

### 2026-09-12 — Sửa thêm 1 gốc rễ nữa: "file được tạo ra nhưng không bao giờ được import ở đâu khác" (user: "muốn sửa cái này trong phần agent chứ không phải trong code game")

Đây chính là tình trạng gốc của `Ball.js`/`Paddle.js`/`Brick.js`: 3 class được viết đầy đủ, đúng cú pháp, nhưng `game.js` chưa từng import chúng — nên game không bao giờ tạo paddle/ball/collider thật. Không giống check ở trên (an toàn ở mọi giai đoạn), check này có rủi ro báo nhầm nếu chạy theo từng task (dự án chia nhiều task hợp lệ: task 3 tạo file, task 5 mới import). Đã hỏi và user chọn: **chỉ chạy 1 lần lúc final verification** — bước "final artifact verification" có sẵn (`_runArtifactVerification`, gọi từ `_phaseFinalIntegration`, đã kiểm tra deliverable thiếu/README trỏ tới file ma).

- Thêm `findUnreferencedExportingFiles()` vào `moduleContracts.ts`: nhận toàn bộ file `.js/.jsx/.ts/.tsx/.mjs/.cjs/.html` của project đã xong, tìm file nào có export thật (class/function/const/`module.exports`) nhưng basename của nó không xuất hiện dưới dạng chuỗi import/require/`<script src>` ở BẤT KỲ file nào khác. Loại trừ: file test (`*.test.js`, `tests/`), entry point quy ước (`index.*`, `main.*`, `app.*`, `server.*`, `*.config.*`, `bin/*`), file không có export gì cả.
- Nối vào `_runArtifactVerification()` qua `_findUnreferencedFilesAtFinalDelivery()` mới — có giới hạn số file/kích thước file để tránh chậm trên project lớn, và tự nuốt lỗi (không bao giờ làm hỏng final delivery vì chính bản thân check).
- **Cố ý để dạng cảnh báo (advisory), KHÔNG ép `ok=false`/không chặn hoàn thành** — khác với các check khác trong hàm này (tất cả đều chặn). Lý do: đây là heuristic mới, dùng so khớp tên file khá lỏng (không phải module resolution thật) để ưu tiên "bỏ sót còn hơn báo nhầm" — 1 lần báo nhầm chặn nhầm 1 bản build đúng và trung thực còn tệ hơn 1 lần bỏ sót. Xuất hiện trong `summary`/journal/assumption để con người hoặc vòng sau thấy, không tự động fail run.
- 6 test mới tái hiện đúng ca Ball/Paddle/Brick, cộng các ca không được báo nhầm: file được import thật, file chỉ được `<script src>` gọi tới, entry point quy ước, file test, file không export gì.
- **270/270 test pass** (toàn bộ suite), lint sạch.

**Có thể cân nhắc sau này:** nếu check này chạy ổn nhiều lần không báo nhầm, có thể nâng thành chặn cứng (`ok=false`) giống các check khác trong cùng hàm.

### 2026-09-13 — Benchmark đầu tiên trên goal mới (Word add-in) chết lặng lẽ giữa Round 4 — root-cause + fix durability

Chuyển mục tiêu test sang `test/word_addin_e2e.js` (goal: Word add-in quản lý tài liệu tham khảo, chạy trên cả Mac/Windows, dùng Office.js task pane) để kiểm chứng pipeline không chỉ hoạt động tốt với brick-breaker mà tổng quát được với 1 domain hoàn toàn khác. Meta-agent tự thiết kế đúng 6 agent chuyên biệt cho domain này (Researcher, Strategist, Architect, Builder Frontend, Critic, Verifier — mỗi agent 1 model khác nhau), đúng tinh thần yêu cầu gốc trong `CLAUDE.MD`.

**Sự cố:** Sau ~47 phút chạy (heartbeat cuối lúc 2820s), tiến trình biến mất hoàn toàn — không exception, không dòng `[ERROR]`, không completion marker trong log, đúng lúc đang ở Round 4/4 ("Scoring & vote") của vòng tranh luận đầu tiên.

**Bằng chứng root cause:** báo cáo JSON cuối cùng trước khi chết ghi `freeMemoryBytes: 150044672` (~143MB free trên tổng 32GB) — dấu hiệu rất mạnh của bị hệ điều hành kill vì cạn RAM (jetsam/OOM), không phải lỗi ứng dụng. Không tìm thấy crash report trong `~/Library/Logs/DiagnosticReports/` quanh thời điểm đó — phù hợp với 1 lần bị kill lặng lẽ (SIGKILL) hơn là ứng dụng tự crash. Microsoft Edge đã tự mở lại (14 process) sau khi trước đó đã chủ động đóng — góp phần vào áp lực RAM.

**Phát hiện quan trọng khi điều tra khả năng resume:** `DynamicTeam.run()` (trong `src/dynamic/DynamicTeam.ts`) chỉ build transcript đầy đủ trong biến nội bộ (mảng string) và chỉ ghi ra `dynamic_team_debate.md` **đúng 1 lần, sau khi CẢ 4 vòng xong** (do `AgentOrchestrator._designAndRunTeamInternal()` chỉ gọi `workspace.writeFile(...)` sau khi `team.run()` resolve). Hệ quả: toàn bộ ~47 phút làm việc thật của Round 1-3 (mỗi agent tự đề xuất, phản biện chéo, tự sửa lại) **không được lưu ở bất kỳ đâu trên đĩa** — chết lúc Round 4 nghĩa là mất sạch, `--resume` không cứu được gì vì không có gì để đọc lại.

**Fix (agent-code, không phải sửa game):**
- Thêm `onTranscriptUpdate?: (partialTranscript: string) => void` vào `DynamicTeamEvents` (`src/dynamic/DynamicTeam.ts`) — gọi ngay sau mỗi lần `transcript.push(...)` của Round 1, 2, 3 (không chỉ ở cuối Round 4), truyền toàn bộ transcript gộp tới thời điểm đó.
- Nối trong `AgentOrchestrator._designAndRunTeamInternal()`: `onTranscriptUpdate` ghi thẳng xuống `dynamic_team_debate.md` ngay lập tức (không đợi hết cả debate), có đánh dấu rõ "(in progress — a crash here would lose only the round in flight, not the rounds already written)" để phân biệt bản đang chạy dở với bản hoàn chỉnh cuối cùng (bản cuối vẫn ghi đè sạch như cũ khi `team.run()` resolve xong).
- **Kết quả:** nếu bị OOM-kill lần nữa, tối đa chỉ mất phần vòng đang chạy dở, không mất toàn bộ debate đã hoàn thành — và tiện thể đáp ứng luôn yêu cầu trước đó của user ("muốn coi chi tiết từng bước, llm trả về gì") vì giờ có thể mở/tail file `dynamic_team_debate.md` ngay trong lúc chạy để xem nội dung đầy đủ từng vòng, không chỉ bản clip 120 ký tự trong log real-time.
- `npm run compile` sạch, chưa chạy lại full test suite cho thay đổi này (chỉ thêm callback optional, không đổi hành vi khi không có listener).

**Đã làm:** đóng lại Microsoft Edge (`osascript -e 'quit app "Microsoft Edge"'`), xác nhận RAM hồi phục (~9.8GB free lúc khởi động lại), khởi động lại benchmark Word add-in từ đầu (workspace mới `demo/word-addin-refs-2026-09-13T03-03-22-370Z`, PID mới, chạy nền qua `nohup ... & disown`).

**Còn tồn đọng:**
- Chưa xác nhận 100% nguyên nhân chết là do OS kill RAM (thiếu dòng log kernel xác nhận trực tiếp) — kết luận dựa trên bằng chứng gián tiếp mạnh (143MB free, chết êm không exception).
- Chưa có cơ chế chủ động: benchmark harness hiện chỉ log RAM ở heartbeat 60s, không có cảnh báo sớm/tạm dừng khi RAM xuống thấp giữa 2 heartbeat — nếu RAM tụt nhanh vẫn có thể bị kill mà không kịp phản ứng. Chưa làm vì user chưa yêu cầu, chỉ mới fix phần mất dữ liệu.
- Chạy 6 agent × 4 vòng với nhiều model lớn (mistral-small3.2:24b, qwen2.5-coder:14b-instruct, deepseek-coder-v2:16b × 2) trên máy 32GB rõ ràng là căng RAM — nếu còn chết vì OOM lần nữa, có thể cần giảm `num_ctx`/`num_predict` cho debate hoặc giới hạn số agent chạy đồng thời (hiện đã là tuần tự, không song song, nên áp lực RAM đến từ việc model không được giải phóng kịp giữa các lượt gọi, không phải chạy chồng lấn).

### 2026-09-13 — Đánh giá lại máy thực tế và phương án triển khai tiếp theo

Theo yêu cầu user: đọc project log, đưa ra giải pháp cho máy này, sau đó ghi lại phương án. **Phần dưới là kết quả kiểm tra và đề xuất; chưa triển khai các thay đổi được đề xuất, chưa đổi cấu hình Ollama hoặc can thiệp benchmark trong lượt đánh giá này.**

**Cấu hình và bằng chứng đã kiểm tra:**
- Máy thực tế là **Apple M4, 10 CPU core, RAM 32 GiB** (`os.totalmem()` = 34359738368 bytes), khác thông tin 24GB trong `CLAUDE.MD`. SSD trong còn khoảng 80 GiB; `/Volumes/Data` còn khoảng 521 GiB tại thời điểm kiểm tra.
- RAM free do Node báo khoảng 0,26 GiB, nhưng `memory_pressure -Q` báo 34% và `kern.memorystatus_vm_pressure_level` = 1 (normal); swap đang dùng khoảng 2568 MiB. Các phép đo thực hiện ở những thời điểm gần nhau, không phải một snapshot nguyên tử. **RAM free thấp chưa đủ chứng minh OOM**; nguyên nhân Word add-in dừng vẫn chưa được xác nhận bằng exit signal hoặc log hệ điều hành. Cũng chưa đủ bằng chứng kết luận model không giải phóng kịp là nguyên nhân duy nhất.
- Brick Breaker đã có bằng chứng chạy được sau sửa tay theo mục ngày 12/9. Đây **chưa phải benchmark tự động thành công**; chưa có xác nhận đầy đủ điều khiển và chiến thắng sau 20 màn.
- Đối chiếu code: `DynamicTeam.run()` gọi `onTranscriptUpdate` sau khi hoàn thành cả vòng 1, 2, 3, chưa lưu sau từng phản hồi agent. Trong `resume()`, khi thiếu quyết định hoàn chỉnh, orchestrator vẫn chạy lại toàn bộ debate. Lưu transcript từng vòng giúp giữ nội dung nhưng **chưa phải Resume từ đúng lượt đã dừng**.

**1. Bộ model khởi đầu — dùng model đã cài, giữ 5 model khác nhau và 4 vòng debate:**

| Vai trò đề xuất | Model |
| --- | --- |
| Thiết kế giải pháp, xử lý code khó | `devstral-small-2:latest` |
| Lập kế hoạch triển khai, viết code | `qwen2.5-coder:14b-instruct` |
| Phản biện kỹ thuật | `deepseek-coder-v2:16b` |
| Phân tích yêu cầu, trải nghiệm người dùng | `gemma3:12b` |
| Kiểm tra giả định, tiêu chí nghiệm thu | `qwen3:8b` |

Đây là cấu hình đề xuất để benchmark, chưa chứng minh là bộ model tốt nhất. Giữ 4 vòng: đề xuất → phản biện → sửa đề xuất → chấm điểm; chỉ thêm agent thứ sáu khi cần chuyên môn bổ sung. Tiếp tục loại `qwen3-coder:30b` khỏi lựa chọn tự động do lịch sử lỗi tải model trên máy này.

**2. Quản lý RAM ở cả Ollama và agent:**
- Cấu hình server khởi đầu đề xuất: `OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_NUM_PARALLEL=1`. Đây là giới hạn phía server, bổ sung cho hàng đợi phía ứng dụng. Ollama xác nhận request song song làm tăng bộ nhớ context: https://docs.ollama.com/faq#how-does-ollama-handle-concurrent-requests
- Thêm khóa dùng chung giữa các phiên benchmark/extension. Hiện `generationQueue` nằm trong từng instance `OllamaClient`, chưa ngăn các tiến trình khác cùng gọi model.
- Khi đổi model, xác nhận model cũ đã được giải phóng qua API trạng thái trước khi nạp model tiếp theo. Hiện `unloadModel()` có thể chỉ ghi cảnh báo khi lỗi và caller vẫn tiếp tục tải model mới. Phải phân biệt lỗi cleanup sau một lỗi khác với lỗi unload trước khi chuyển model.
- Theo dõi memory pressure và tốc độ tăng swap trong lúc chạy, không chỉ RAM free ở heartbeat. Khi áp lực tăng: lưu checkpoint, giảm context cho lượt tiếp theo hoặc tạm dừng có kiểm soát; không tự đóng ứng dụng của user.
- Context khởi đầu đề xuất: 8K cho đề xuất/phản biện, 16K cho chấm điểm và code khó. Chỉ đưa file liên quan vào context, chừa ngân sách output; đo lại trước khi tăng. Đây là mức thử nghiệm theo ngân sách máy, không phải mức tối ưu đã xác nhận.
- Có thể thử Flash Attention cùng KV cache `q8_0` nếu backend hỗ trợ và đo lại chất lượng. Mức giảm bộ nhớ áp dụng cho KV cache, không phải toàn bộ model: https://docs.ollama.com/faq#how-can-i-set-the-quantization-type-for-the-kv-cache

**3. Checkpoint và giám sát tiến trình — ưu tiên trước benchmark dài tiếp theo:**
- Lưu trạng thái có cấu trúc sau mỗi phản hồi agent: round, agent ID, model, đầu vào, đầu ra, scorecard và lượt đã hoàn thành. Ghi file nguyên tử, kiểm tra checkpoint phù hợp với run/goal trước khi sử dụng.
- Resume từ lượt chưa hoàn thành, tái sử dụng kết quả đã lưu; không chạy lại R1–R3 khi chỉ còn thiếu một judge ở R4.
- Thêm tiến trình giám sát để ghi exit code/signal khi worker chết và xử lý trạng thái `running` bị bỏ lại. Không thể dựa vào chính worker để ghi log sau SIGKILL; thiếu bằng chứng hệ điều hành vẫn không được tự kết luận OOM.

**4. Chất lượng sản phẩm phải được kiểm chứng bằng hành vi:**
- Tạo từng phần chức năng chạy được, kiểm tra ngay trước khi mở rộng. LLM đồng thuận hoặc build pass chưa đủ để đánh dấu hoàn thành.
- Với Brick Breaker: hoàn thiện một màn có điều khiển, va chạm, điểm và mất mạng; sau đó mở rộng đủ 20 màn. Kiểm thử pause/resume, restart, chuyển màn, dữ liệu level nằm trong vùng chơi và chiến thắng sau màn 20.
- Nếu cùng lỗi lặp lại hai lần, đổi cách chẩn đoán hoặc kế hoạch sửa; tránh tiếp tục tám lần sửa gần giống nhau.
- Đưa cơ chế này vào agent tổng quát với tiêu chí nghiệm thu theo từng dự án; không dùng sửa tay game làm bằng chứng agent đạt yêu cầu.

**5. Ổ đĩa và tiêu chuẩn nghiệm thu:**
- Có thể thử đặt một model dùng thường xuyên lên SSD trong, đo thời gian tải trước/sau rồi mới quyết định mở rộng. Chưa chuyển kho model; chưa khẳng định chuyển SSD sẽ giải quyết lỗi USB đã gặp.
- Thứ tự triển khai đề xuất: **checkpoint từng lượt → quản lý RAM dùng chung → kiểm thử hành vi → benchmark workspace mới hoàn toàn**.
- Tiêu chuẩn đạt: agent tự tạo sản phẩm vượt kiểm thử độc lập, không cần sửa tay; phục hồi được khi gián đoạn và ghi rõ các tiêu chí chưa đạt. Chưa có bằng chứng để cam kết chất lượng tương đương mục tiêu “Astra Ultra” chỉ bằng tăng model hoặc số vòng debate.

### 2026-09-17 — Triển khai mục 5 đợt trước: checkpoint từng lượt agent + quản lý RAM dùng chung + auto-resume khi lỗi

Theo đúng thứ tự đề xuất ở mục 5 phía trên (chỉ làm 2 mục đầu trong đợt này: checkpoint từng lượt → quản lý RAM dùng chung; kiểm thử hành vi/benchmark thật chưa làm trong đợt này).

**1. Checkpoint per-turn cho dynamic debate (trước đây chỉ checkpoint theo cả vòng — xem mục 2026-09-13):**
- `DynamicTeam.run()` (`src/dynamic/DynamicTeam.ts`) giờ nhận thêm `resume?: DynamicTeamCheckpoint` và bắn `events.onCheckpoint(...)` sau **từng lượt agent/judge riêng lẻ** (không chỉ sau mỗi vòng) — 1 crash giữa vòng chỉ mất đúng 1 lượt gọi model đang dở, không mất cả vòng. Type `DynamicTeamCheckpoint` mới trong `src/types.ts`.
- `AgentOrchestrator._designAndRunTeamInternal` ghi checkpoint này ra `agents/dynamic_team_checkpoint.json` (atomic write) sau mỗi lượt; xoá file khi debate hoàn tất (quyết định cuối đã thay thế). `resume()` đọc lại đúng **plan cũ** (không re-design team — meta-agent không deterministic, re-design sẽ làm sai lệch mapping agent id) + checkpoint dở dang, đưa vào `team.run()` để tiếp tục đúng lượt còn thiếu thay vì chạy lại từ vòng 1.
- Phát hiện 1 bug alias thật khi viết test: closure snapshot ban đầu trả thẳng tham chiếu mảng `proposals`/`critiques`/`completedAgentIds` đang bị mutate tiếp — mọi checkpoint "cũ" hoá ra trỏ chung 1 mảng, tất cả hiện length cuối cùng. Đã sửa bằng cách clone toàn bộ mảng trong `snapshot()`. Nếu không có test per-turn thì bug này sẽ lọt vào checkpoint file thật.

**2. Resume không còn bị chặn ở status "running" (đúng lỗ hổng nêu ở mục 2026-09-13: crash cứng luôn để lại "running" mãi mãi, mà resume() cũ từ chối đụng vào "running"):**
- `RunLock` mới (`src/workspace/RunLock.ts`): heartbeat mỗi 20s vào `.agent-workspace/run.lock` (pid + heartbeatAt) trong lúc `start/resume/runAutonomousGoal/designAndRunTeam` đang chạy. `resume()` giờ: nếu status là "running" nhưng lock đã mất/pid chết/heartbeat quá cũ (90s) → coi là orphaned do crash, tự phục hồi; nếu lock còn sống thật → vẫn từ chối như cũ (tránh 2 tiến trình cùng resume 1 workspace).

**3. Khoá RAM dùng chung giữa các tiến trình (đúng mục "Thêm khóa dùng chung giữa các phiên benchmark/extension" nêu ở mục 2026-09-13):**
- `ModelLoadLock` mới (`src/ollama/ModelLoadLock.ts`): file lock toàn cục (`os.tmpdir()/local-multi-agent-coder-locks/<sha1(baseUrl)>.lock`, dùng `fs.openSync(wx)`, không thêm dependency nào) khoá quanh toàn bộ `OllamaClient._sendChatRequestExclusive` — chỉ 1 tiến trình trên máy được giữ 1 model "in flight" tại 1 thời điểm, không chỉ trong 1 process như `generationQueue` cũ. Có stale-reclaim (pid chết hoặc quá `staleMs`), `shouldAbort` để Stop vẫn hoạt động khi đang chờ khoá, và safety-valve `timeoutMs` để không bao giờ treo cứng.
- Phát hiện 1 bug thật khi viết test: ownership check ban đầu so `pid + acquiredAt` (mili-giây) — `Date.now()` gọi liên tiếp thực tế trả **cùng giá trị** (đã xác nhận bằng `node -e`), nên 1 lượt reclaim nhanh có thể trùng mili-giây với lượt gốc và `release()` xoá nhầm khoá của người khác. Đã sửa bằng random `token` (8 byte hex) làm nonce sở hữu thay vì timestamp.

**4. Ghi file nguyên tử dùng chung (đúng mục "Ghi file nguyên tử" nêu ở mục 2026-09-13):**
- `src/utils/atomicFile.ts` mới: `writeFileAtomic` = ghi file tạm cùng thư mục rồi `renameSync` đè lên đích. `AgentWorkspace.writeProjectState`/`writeFile` (tức là toàn bộ checkpoint: `project_state.json`, `dynamic_team_checkpoint.json`, `task_plan.json`, ...) giờ đi qua đường này — 1 crash giữa lúc ghi không còn để lại file half-written bị `JSON.parse` âm thầm bỏ qua.

**5. Auto-resume khi có lỗi để hoàn thành dự án (`tạo resume tự động khi có lỗi`):**
- `scripts/run-goal-once.js`: chạy 1 lượt goal mới hoặc resume (tự nhận biết qua có `project_state.json` hay chưa), exit code 0 chỉ khi status "completed".
- `scripts/run-with-auto-resume.js` (npm script `resume:auto`): supervisor bên ngoài spawn `run-goal-once.js` làm child process, nếu child thoát mà chưa "completed" thì tự respawn ở chế độ resume (tối đa `--max-attempts`, mặc định 8, có backoff) — đúng cái duy nhất có thể làm khi bị SIGKILL/OOM-kill: tiến trình bị giết không thể tự hồi sinh, phải có tiến trình cha bên ngoài theo dõi. Ctrl+C thủ công (SIGINT) tắt cả supervisor lẫn child cùng lúc (cùng process group), không bị hiểu nhầm thành crash cần respawn.
- Chưa làm: tự động resume hoàn toàn không cần click trong VS Code interactive (không thể — nếu extension host chết thì code bên trong nó chết theo, không có gì tự hồi sinh được; đã sửa để nút "Resume Workflow" có sẵn hoạt động đúng sau crash, nhưng không tự bấm giùm).

**Bằng chứng:** `npm run check` (compile + lint + 299/299 test) sạch. Test mới: `test/unit/atomicFile.test.js`, `test/unit/runLock.test.js`, `test/unit/modelLoadLock.test.js`, thêm 3 case vào `test/unit/dynamicAgents.test.js` (per-turn checkpoint, resume mid-round, ignore checkpoint sai goal), thêm 3 case vào `test/autonomousResume.test.js` (resume dùng lại đúng plan cũ từ checkpoint dở dang, resume phục hồi "running" mồ côi, resume từ chối "running" còn sống). Cả 2 bug thật (alias mảng, timestamp collision) đều do viết test bắt được trước khi merge, không phải do chạy thật.

**Chưa làm/còn tồn đọng:** chưa chạy thật với model thật để xác nhận per-turn checkpoint hoạt động đúng khi có model thật crash giữa chừng (chỉ test bằng fake client); chưa benchmark `run-with-auto-resume.js` qua 1 lần kill -9 thật; mục 3 (kiểm thử hành vi) và mục 4 (benchmark workspace mới) trong danh sách đề xuất vẫn chưa làm.

### 2026-09-17 (tiếp) — Chatbot Q&A độc lập (Docker + Tailscale), theo yêu cầu boss

Boss brainstorm rồi yêu cầu làm luôn: 1 nhánh dùng lại core debate nhưng chạy như chatbot trả lời câu hỏi thường (vd "có nên mua iPhone 18 không") thay vì build phần mềm, deploy Docker kèm link Tailscale, UI web có setting chỉnh số vòng debate + số AI Agent. Trước khi code, đã hỏi lại boss 3 quyết định kiến trúc và được xác nhận:

1. **Số vòng debate là con số thật** (không phải chỉ bật/tắt 4 giai đoạn cũ) → xây **engine debate mới, riêng biệt** thay vì generalize `DynamicTeam` — không đụng vào `DynamicTeam`/checkpoint-resume vừa cứng hoá ở mục trên.
2. **Số agent tối thiểu cho phép xuống 3** (không giữ cứng >=5 như pipeline build phần mềm) để trả lời nhanh hơn.
3. **Chấp nhận thêm dependency `ws`** (npm dependency ĐẦU TIÊN của dự án, trước giờ 0 dependency) để có WebSocket thật, thay vì tự viết SSE tay để giữ 0-dependency.

**Đã build:**
- `src/dynamic/QaDebate.ts` — engine mới: Round 1 mỗi agent tự nêu quan điểm → Round 2..N mỗi agent đọc quan điểm mới nhất của người khác rồi sửa lại quan điểm (rounds:1 = chế độ nhanh, không có vòng sửa nào) → 1 lệnh gọi tổng hợp cuối cùng ra câu trả lời thật (không phải "chọn 1 đề xuất thắng" như DynamicTeam, mà tổng hợp đồng thuận/bất đồng + khuyến nghị rõ ràng). Dùng lại `DynamicAgent` y nguyên, không sửa gì.
- `src/prompts/qaPersonas.ts` — 8 persona tĩnh (Objective Analyst, Skeptical Advisor, Practical Consumer, Domain Expert, User Advocate, Market Researcher, Contrarian, Risk Assessor), KHÔNG dùng meta-agent thiết kế team theo từng câu hỏi như `AgentFactory` (đỡ tốn 1 lượt gọi LLM design mỗi câu hỏi, trả lời nhanh hơn và ổn định thành phần hơn).
- `src/server/` (`index.ts`, `routes.ts`, `chatConfig.ts`, `askHandler.ts`) — server Node thuần (`http` + `ws`), không dùng framework. `chatConfig.ts` dùng lại đúng `writeFileAtomic` đã xây ở mục trên. `ModelReadinessService` hoá ra đã nhận sẵn ngưỡng số model tuỳ chỉnh qua constructor (`requiredDistinctModels = 5`) — không cần sửa gì, chỉ truyền `agentCount` cấu hình vào.
- `public/` — web UI thuần HTML/CSS/JS (không framework, không bundler), giao diện chat mobile-first, panel setting (vòng debate, số agent, bật/tắt web search), kết nối WebSocket nhận tiến trình debate real-time.
- `Dockerfile` (multi-stage, `npm run compile` có sẵn hoạt động y nguyên vì `@types/vscode` chỉ là type, bị xoá lúc compile) + `docker-compose.yml` + `tailscale/config/serve.json`.
- **Tailscale sidecar**: trước khi viết compose, đã tra cứu thật (WebSearch + WebFetch) hướng dẫn chính thức của Tailscale (`tailscale.com/blog/docker-tailscale-guide`) thay vì đoán từ trí nhớ — vì nhớ nhầm 1 chỗ quan trọng: pattern đúng là app container `network_mode: service:<tailscale-container>` (dùng chung network namespace), và `Proxy` trong `serve.json` phải trỏ `http://127.0.0.1:<port>` chứ không phải hostname DNS nội bộ của compose như bản nháp đầu tiên định làm — nếu không tra sẽ ship 1 config sai ngay từ đầu.

**Bằng chứng:** `npm run check` sạch — **326/326 test** (299 cũ + 27 mới: `qaDebate.test.js` 9 ca, `chatConfig.test.js` 7 ca, `serverRoutes.test.js` 11 ca gồm cả 1 test WebSocket end-to-end thật qua cổng ephemeral). Đã tự chạy `node out/server/index.js` thật (ngoài Docker) và `curl` xác nhận `/`, `/api/config`, `/api/models`, `/app.js` trả đúng. Đã chạy `docker compose config` (validate cú pháp/resolve biến) — đúng, không lỗi; `npm ci` xác nhận lockfile khớp sau khi thêm `ws`.

**Chưa làm/còn tồn đọng:**
- **Chưa chạy được `docker compose up` thật** — `docker` CLI có cài trên máy này nhưng Docker Desktop daemon không chạy (`docker info` báo không kết nối được socket). Boss cần tự mở Docker Desktop trên Mac mini rồi chạy.
- **Chưa test với Tailscale thật** — cần boss tự tạo `TS_AUTHKEY` từ tài khoản Tailscale của mình, dán vào `.env` (đã có `.env.example` hướng dẫn), rồi tự xác nhận mở được `https://debate-chatbot.<tailnet>.ts.net` trên điện thoại.
- **Chưa hỏi qua model thật** — toàn bộ test `QaDebate`/server dùng fake Ollama client; chưa xác nhận chất lượng câu trả lời thật khi hỏi 1 câu như "có nên mua iPhone 18 không" qua model thật.
- Web search (`WebSearchService`) tự nó chưa test lại thời điểm này — dùng lại nguyên xi, không sửa gì.
- **Đính chính**: mục trên viết nhầm "máy trong môi trường code này không có Docker daemon sống" như thể đây là máy khác — thực ra đây CHÍNH LÀ Mac mini M4 32GB thật của dự án (xác nhận qua phiên làm việc ngay sau, mục dưới: `ollama list`, `sysctl hw.memsize` chạy trực tiếp, có Ollama 0.34.0 thật đang serve).

### 2026-09-17 (tiếp nữa) — Redesign UI (extension + chatbot), mở rộng RAM kill-app, tải model mới

Boss yêu cầu 3 việc: (1) thiết kế lại UI cả VS Code extension lẫn chatbot, dạng "chain of thought/task"; (2) mở rộng phần tự đóng app giải phóng RAM — chỉ áp dụng trong extension (không áp dụng cho chatbot/Docker vì container không đóng được app trên host); (3) tìm và tải về model mới nhất/mạnh nhất chạy được trên máy M4 32GB RAM. Đã hỏi lại 3 câu hỏi xác nhận trước khi làm (giữ nguyên yêu cầu tối thiểu 5 model cho pipeline build phần mềm hay nới lỏng cho chatbot xuống 3; đóng app tự động hay vẫn hỏi qua UI; redesign VS Code panel ở mức nào) — boss chọn: tải đủ 4 model đề xuất, vẫn hỏi qua UI nhưng mở rộng sang `start()`/`resume()`, và làm lại cấu trúc VS Code panel hoàn toàn.

**Phát hiện quan trọng: đây chính là máy Mac mini M4 32GB thật của dự án.** `ollama --version` → 0.34.0 thật đang chạy; `ollama list` thấy đúng bộ model đã ghi trong log trước (`qwen3-coder:30b`, `devstral-small-2`, `mistral-small3.2:24b`, ...); `sysctl hw.memsize` = 34359738368 (32 GiB); model lưu ở `/Volumes/Data/LLM_model` (ổ USB ngoài, đúng như log cũ mô tả), `~/.ollama/models` rỗng.

**1. Tải model mới:** Tra thư viện Ollama thật (không tin blog SEO ghi "Gemma 4"/"Qwen3.6" — đã verify qua `ollama.com/library` thật, xác nhận các tag này tồn tại thật). Chọn tải: `gemma4:31b`, `qwen3.6:35b`, `qwen2.5-coder:32b`, `gpt-oss:20b` (không đụng `qwen3-coder:30b` cũ — giữ nguyên quyết định tránh dùng làm default vì lịch sử SIGBUS).
- **3/4 thành công**: `qwen3.6:35b` (22GB), `qwen2.5-coder:32b` (19GB), `gpt-oss:20b` (13GB).
- **`gemma4:31b` thất bại 3 lần thử liên tiếp** (I/O error → digest mismatch → unexpected EOF), **rồi thành công ở lần thử thứ 4** (19GB, sau khi đã xử lý xong sự cố OneDrive bên dưới — mục §OneDrive symlink đệ quy). Việc tải thành công ngay sau khi loại bỏ nguồn I/O cạnh tranh (OneDrive File Provider từng ghim CPU 98%+ do vòng lặp symlink) xác nhận đúng giả thuyết: nguyên nhân 3 lần thất bại trước là I/O contention thật trên ổ USB `/Volumes/Data`, không phải lỗi ngẫu nhiên từ phía Ollama/mạng. Cả 4/4 model đã tải đủ: `gemma4:31b` (19GB), `qwen3.6:35b` (22GB), `qwen2.5-coder:32b` (19GB), `gpt-oss:20b` (13GB).
- **Chủ động không đổi model mặc định của pipeline build phần mềm** (`AgentWorkspace.ts` role→model mapping) sang các model mới này — dự án có tiền lệ rõ ràng (lịch sử SIGBUS) là không đưa model chưa qua benchmark thật vào làm default; chỉ tải về theo đúng yêu cầu, chưa validate nên chưa dùng làm mặc định.

**2. RAM kill-app mở rộng sang `start()`/`resume()`:** `_offerRamOptimizationIfNeeded()` + `_preflightSystemResources()` trước đây chỉ chạy trong `runAutonomousGoal()`. Đã thêm vào `start()` (chưa từng gọi RAM check nào trước đây!), `resume()` (trước đây chỉ chạy khi resume vào nhánh `autonomous`, giờ chạy cho cả `fixed`), và `designAndRunTeam()`. Vẫn giữ nguyên cơ chế hỏi qua UI (60s timeout, mặc định từ chối) — không tự động đóng app không hỏi, đúng lựa chọn của boss.

**3. Redesign UI — cả 2 mặt đều đổi sang "chain of thought/task":**
- **Chatbot** (`public/app.js`+`style.css`): thay dòng "status" đơn lẻ bằng task-panel có thể thu gọn — mỗi vòng debate là 1 bước (running=pulse xanh dương, done=✓ xanh lá), mỗi bước mở ra xem từng agent trả lời gì. Panel tự thu gọn khi có câu trả lời cuối, bấm vào xem lại được.
- **VS Code panel** (`src/webview/webviewHtml.ts`, viết lại hoàn toàn — 1076 dòng cũ, cấu trúc mới hợp nhất 5 section rời rạc cũ (Pipeline/Debate Board/Tasks/Activity Feed đều tách riêng) thành 1 "Reasoning & Tasks" chain duy nhất: mỗi phase trong timeline là 1 bước có thể thu gọn, bước đang chạy tự mở ra kèm các activity + task con lồng bên trong. **Giữ nguyên 100% message contract với `PanelProvider.ts`** (đã grep đối chiếu từng `postMessage`/`case` cả 2 chiều, không phải sửa `PanelProvider.ts` dòng nào).
- **Xác nhận bằng ảnh chụp màn hình thật** (không chỉ đọc code): viết script dùng CDP (Chrome DevTools Protocol) qua Microsoft Edge headless thật, giả lập `acquireVsCodeApi()` + biến `--vscode-*`, bắn `window.postMessage` với dữ liệu mẫu, chụp ảnh. Cả 2 giao diện đều render đúng như thiết kế.

**Sự cố kỹ thuật giữa chừng (đáng ghi lại vì liên quan trực tiếp tới lịch sử ổn định ổ đĩa của máy này):**
- Ngay sau khi bắt đầu tải 4 model (chạy nền), `tsc` bắt đầu báo lỗi "Stale NFS file handle" / "Operation timed out" / "ETIMEDOUT: connection timed out" liên tục khi đọc đúng 1 file `node_modules/.bin/tsc` — trong khi mọi file khác trong cùng thư mục (kể cả node_modules khác) đọc bình thường. Chẩn đoán: OneDrive sync client (đồng bộ chính thư mục code này) và Ollama pull cùng tranh I/O/băng thông trên cùng 1 ổ USB ngoài (`/Volumes/Data`), khiến 1 file cụ thể bị kẹt ở trạng thái chờ ở tầng OS/File-Provider.
- Xác nhận ổ đĩa KHÔNG hỏng toàn bộ (`echo test > /Volumes/Data/write_test.txt` ghi/đọc bình thường ngay cả lúc đang kẹt) — chỉ 1 file cụ thể bị kẹt cache/handle cũ.
- Retry theo vòng lặp 20s x 30 lần không tự hết dù đợi ~2.5 phút; đã thử `rm -rf node_modules/typescript node_modules/.bin/tsc && npm install typescript@5.9.3 --no-save` để lấy lại file mới — **thành công ngay**, `tsc` chạy bình thường sau đó, `npm ci` xác nhận lockfile không bị hỏng bởi thao tác này.
- Bài học: khi ổ `/Volumes/Data` (USB ngoài, cùng ổ chứa cả code lẫn `LLM_model`) bị tải I/O nặng đồng thời từ 2 nguồn trở lên (OneDrive sync + Ollama pull), rủi ro treo/lỗi ghi thật không chỉ giới hạn ở Ollama (đã biết từ trước) mà còn ảnh hưởng cả việc build code — nên tránh chạy tải model lớn đồng thời với việc code/compile nặng nếu có thể, hoặc chấp nhận tsc có thể tạm treo vài phút.

**Sự cố nghiêm trọng hơn phát hiện sau đó cùng ngày — OneDrive tự tạo symlink đệ quy vô hạn, ghim CPU 98-195%:** Boss báo "OneDrive đang bị lặp vòng, có thư mục OneDrive lại có thêm 1 thư mục OneDrive con". Điều tra thấy `OneDrive-Personal/OneDrive` là 1 **symlink trỏ ngược lại chính thư mục cha của nó** (`OneDrive-Personal/OneDrive -> OneDrive-Personal`), tạo lúc 13:41:17 — cùng khung giờ với sự cố tsc/ollama ở trên. Lúc phát hiện, cả `OneDrive.app` và `OneDrive File Provider.appex` đang ngốn 98-99% CPU liên tục — gần như chắc chắn đang cố quét cây thư mục đệ quy vô hạn này. **Đây rất có thể chính là nguyên nhân thật (không chỉ "I/O contention chung chung") của các lỗi tsc/ollama pull ở mục trên và của cả 3 lần `gemma4:31b` thất bại.**
- Root cause: OneDrive không lưu ở vị trí chuẩn của Apple (`~/Library/CloudStorage/...`, thư mục này rỗng) mà bị cấu hình lưu ở ổ ngoài (`/Volumes/Data/.CloudStorage/Data/...`). Preferences của chính OneDrive (`defaults read com.microsoft.OneDrive-mac`) có `DisableFileProvider_Requirements = 1` — ràng buộc vị trí lưu chuẩn của Apple bị tắt để cho phép cấu hình phi chuẩn này. Khi chạy ngoài đường dẫn chuẩn, logic nội bộ của OneDrive (tạo symlink `~/OneDrive` tương thích ngược cho app cũ) tính sai đường dẫn tương đối → tạo nhầm symlink đó vào bên trong chính nó thay vì vào `$HOME` — và **lặp lại y hệt mỗi lần khởi động lại OneDrive** (xóa symlink, mở lại app → symlink lỗi xuất hiện lại ngay, xác nhận bằng thực nghiệm 2 lần).
- Xử lý: quit OneDrive (`osascript -e 'quit app "OneDrive"'`), xóa symlink lỗi (chỉ `rm` trên symlink, không đụng dữ liệu thật bên trong), gỡ cài đặt OneDrive theo yêu cầu boss — xóa `~/Library/Containers/com.microsoft.OneDrive-mac{,Launcher,.FileProvider,.FinderSync}` + `~/Library/Group Containers/UBF8T346G9.{OneDriveSyncClientSuite,Kfm,OfficeOneDriveSyncIntegration}` + `defaults delete` cache — **cố tình không đụng** các Group Container dùng chung `UBF8T346G9.Office*`/`oneauth`/`entrabroker`/`edgemac.widgets`/`ms`/`group.shared` (Word/Excel/PowerPoint/Edge/đăng nhập Microsoft dùng chung, xóa nhầm sẽ hỏng cả bộ Office). Riêng `/Applications/OneDrive.app` sở hữu bởi `root:wheel`, không xóa được vì không có sudo tương tác — bàn giao boss tự xóa qua Finder (kéo vào Thùng rác, xác thực Touch ID/mật khẩu) rồi cài lại qua Mac App Store.
- Boss tự cài lại xong. Check lại: app đã cập nhật (mtime mới), **symlink lỗi không tái xuất hiện** sau lần cài lại này — có vẻ bản mới đã vá hoặc do cài qua App Store dùng đúng cờ chuẩn hơn. CPU cao tạm thời (~195%) ngay sau khi cài lại là do re-index/re-link lại thư mục đồng bộ sẵn có (bình thường), không phải bug lặp cũ.
- **Retry `gemma4:31b` lần 4 ngay sau khi dọn xong OneDrive → thành công** (19GB) — xác nhận đúng giả thuyết nguyên nhân gốc.
- Bài học lớn hơn: khi 1 vị trí lưu trữ (ở đây là 1 ổ USB ngoài) đồng thời phục vụ (a) source code project + build tool, (b) kho model Ollama, VÀ (c) bị OneDrive đồng bộ đè lên trên cùng — bất kỳ tiến trình nào trong 3 nguồn đó gặp sự cố có thể lan sang cả 2 nguồn còn lại qua tranh chấp I/O/CPU thật, không phải hiện tượng độc lập. Nên cân nhắc loại trừ thư mục `LLM_model` và `node_modules` khỏi phạm vi đồng bộ OneDrive (OneDrive Settings → chọn thư mục đồng bộ) nếu sự cố còn tái diễn.

**Bằng chứng:** `npm run check` sạch — compile + lint + **326/326 test** (không có test mới ở đợt này, chỉ sửa `AgentOrchestrator.ts` + viết lại `webviewHtml.ts`, cả 2 đều được cover bởi test suite hiện có — `autonomousResume.test.js` đã stub sẵn `_offerRamOptimizationIfNeeded`/`_preflightSystemResources` nên không cần test mới cho phần RAM).

**Chưa làm/còn tồn đọng:**
- Cả 4/4 model đã tải xong (`gemma4:31b`, `qwen3.6:35b`, `qwen2.5-coder:32b`, `gpt-oss:20b`) — chưa validate bằng benchmark thật trước khi cân nhắc đưa vào default roster, mới chỉ tải về.
- Nên theo dõi thêm vài ngày xem symlink lỗi của OneDrive có tái xuất hiện không dù đã cài lại — nếu còn, cân nhắc loại `LLM_model`/`node_modules` khỏi phạm vi đồng bộ OneDrive.
- UI redesign chưa được xem trực tiếp trong VS Code Extension Development Host thật (chỉ xác nhận qua headless-browser + fake postMessage, chưa chạy `npm run check:release`/`test:vscode` để xác nhận UI mới trong VS Code thật).

### 2026-09-17/18 — Benchmark brick-breaker-20 thất bại (0/5 task): architect giao asset nhị phân cho model chỉ viết được text — root cause, đã sửa trong code chính thức, CHƯA chạy lại

Chạy `npm run test:e2e:brick-breaker` (roster mặc định thật, `allowProductTemplates: false`, không mock) để kiểm tra lại pipeline sau đợt hardening checkpoint/RAM-lock ở mục 2026-09-17 phía trên. Kết quả: chạy sạch ~103 phút, 49 lượt gọi model (1 lỗi transport, tự phục hồi), **không** SIGBUS, **không** OOM — nhưng build vẫn **thất bại thật**: 0/5 task hoàn thành.

**Root cause xác định qua log/workspace thật (`demo/brick-breaker-20-2026-09-17T14-41-16-654Z`):** Ở `sprint-01-task-001` ("Setup project structure"), architect/task-planner đưa `src/assets/spritesheet.png` vào `allowedFiles`. Model code worker chỉ sinh được văn bản → mọi lần ghi file này đều ra 0 byte → heuristic "file is empty" báo lỗi giống hệt nhau ở cả 3 vòng review → cơ chế chống lặp vô hạn ("no progress after 2 identical failures", đã có từ trước) dừng đúng thiết kế sau 8 lần fix → 4 task còn lại bị skip vì phụ thuộc task-001 → gate "0/N tasks completed" chặn hoàn toàn đúng, không giao sản phẩm rỗng. Chi tiết lỗi: `.agent-workspace/tasks/task_plan.json` → `sprint-01-task-001.error`: `"Failed after 8 fix attempts. Last issues: src/assets/spritesheet.png is empty."`. Deterministic recovery (vốn có thể cứu tình huống này) không kích hoạt vì `allowProductTemplates: false` — đúng chủ đích của benchmark này (đo năng lực model thật, không dùng template), nên đây **không phải bug ở `allowProductTemplates`**, mà là bug thật ở tầng lập kế hoạch: giao việc bất khả thi cho model.

**Phát hiện phụ (observability, không phải nguyên nhân fail):** `07_reviewer.md` và `quality_audit.jsonl` ghi lại review **trước khi** merge các kiểm tra tất định (`findUnresolvedRequireImports`, `findBrowserIncompatibleNodeUsage`, heuristic empty/stub) và kết quả quality-audit — nên cả 3 lần trong run này, 2 file log đều hiện `"approved": true` / `qualityScore: 100` dù chính review đó đang chặn task. Gây khó debug nếu chỉ đọc log, không phải nguyên nhân của lần fail này.

**Đã sửa trong code chính thức (chưa chạy lại benchmark để xác nhận, theo đúng yêu cầu "chưa chạy lại"):**
1. `src/utils/moduleContracts.ts`: thêm `isBinaryAssetPath()` — nhận diện phần mở rộng ảnh/audio/video/font/archive (`.png/.jpg/.gif/.bmp/.webp/.ico/.tiff`, `.mp3/.wav/.ogg/.m4a/.flac/.aac`, `.mp4/.mov/.webm/.avi`, `.ttf/.otf/.woff/.woff2/.eot`, `.pdf/.zip`) — cố tình loại trừ `.svg` vì đó là văn bản (XML) thật, model viết được.
2. `src/orchestrator/AgentOrchestrator.ts` (`_normalizeTaskItem`): lọc bỏ mọi đường dẫn binary khỏi `allowedFiles` của MỌI task ngay lúc chuẩn hoá task plan — nghĩa là code worker không bao giờ còn thấy các file này trong phạm vi được phép, nên sẽ không cố viết nữa (thay vì viết ra rồi bị heuristic chặn lặp vô hạn). Mỗi lần lọc đều ghi 1 assumption rõ ràng ("... removed it from allowedFiles. Assets must be generated procedurally in code instead.") để có dấu vết.
3. `src/prompts/agentPrompts.ts` (`COMMON_RULES`, áp dụng cho mọi agent kể cả architect/task-manager/code-worker): thêm luật cứng cấm lập kế hoạch/yêu cầu/viết file nhị phân, yêu cầu thay bằng đồ hoạ sinh procedurally trong code (Canvas/WebGL, `Graphics.generateTexture` của Phaser, SVG inline) và âm thanh sinh bằng WebAudio hoặc bỏ qua — chặn từ gốc (architect không còn nên đề xuất asset nhị phân) cộng với chặn tất định ở bước 2 làm lưới an toàn thứ hai nếu model vẫn phớt lờ.
4. Sửa luôn phát hiện phụ ở trên: `_executeReviewer` giờ ghi thêm 1 block "Final merged decision (after deterministic checks + quality audit)" vào `07_reviewer.md` SAU khi merge xong (giữ nguyên block "LLM reviewer pass (pre-merge)" cũ để không mất thông tin) — nên đọc log sau này sẽ thấy đúng quyết định thật đã chặn/duyệt task.
5. Test mới: `isBinaryAssetPath` (2 case) trong `test/unit/moduleContracts.test.js`; task-normalization tái hiện đúng ca `spritesheet.png` thật (`test/orchestrator.test.js`, xác nhận file bị lọc + assumption được ghi).

**Bằng chứng:** `npm run compile` sạch, `npm run lint` sạch, `npm test` **330/330 pass** (thêm 3 test mới so với lần trước). Chưa chạy lại benchmark thật `test:e2e:brick-breaker` — theo đúng yêu cầu boss "ghi lỗi, bắt đầu fix, chưa chạy lại".

**Cân nhắc còn lại (chưa làm, ngoài phạm vi yêu cầu lần này):** Nếu game thực sự cần hình ảnh trông giống sprite thật (không chỉ hình khối), hướng tiếp theo hợp lý là dạy prompt/architect ưu tiên vẽ bằng code (Canvas path/shape phức tạp hơn) thay vì asset — chưa cần làm nếu chưa có bằng chứng đây là điểm nghẽn chất lượng thật sau khi chạy lại.

### 2026-09-18 — Thêm thông báo tiến trình qua Telegram (theo yêu cầu boss)

Boss yêu cầu thêm phần thông báo từng bước của pipeline qua Telegram. Đã build:

- `src/services/telegramNotifierService.ts` — service gọi Telegram Bot API (`sendMessage`) qua `http(s)` thuần (không thêm dependency mới). Thiết kế "fire-and-forget": `notify()` không bao giờ `throw`, không bao giờ được `await` bởi call site — Telegram chậm/sập không được phép làm treo pipeline đang chạy. Các message được xếp hàng tuần tự với khoảng cách tối thiểu 1.2s giữa các lần gửi để không vượt giới hạn flood của Telegram (~1 tin/giây/chat) khi nhiều phase/fix-attempt dồn dập. Không cấu hình (`TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`) → tự động no-op sau đúng 1 lần cảnh báo, không chặn hay làm lỗi run — đúng nguyên tắc "chỉ hỏi credential khi thật sự cần dùng tính năng đó".
- Gắn vào `AgentOrchestrator`: mọi lần đổi phase (`_setPhase`, 23 điểm gọi trong toàn bộ pipeline — từ toolchain discovery, debate, architecture, task planning, đến từng lượt coding/reviewing/fixing/testing/final integration) đều bắn 1 tin nhắn `🔷 [tên dự án] Tiêu đề phase: chi tiết`; mọi lỗi (`_emit('error', ...)`) bắn `❌ ...`; khi hoàn thành (`_phaseFinalIntegration`) bắn `✅ Hoàn thành!` kèm toàn văn final report (tự cắt ở 4000 ký tự nếu dài hơn giới hạn Telegram).
- `src/utils/loadEnvFile.ts` — loader `.env` tối giản, không dependency (`dotenv` chưa cần vì dự án mới có đúng 1 dependency là `ws`): chỉ điền biến CHƯA có sẵn trong `process.env`, để 1 biến export thật từ shell/Docker luôn thắng file. Gọi ở đầu `src/extension.ts` (VS Code GUI thường không kế thừa được biến môi trường export trong `~/.zshrc` của boss) và ở đầu cả 3 script benchmark (`test/e2e_run.js`, `test/brick_breaker_e2e.js`, `test/word_addin_e2e.js`) để 1 file `.env` ở gốc repo là đủ cho mọi cách chạy.
- `.env.example`: thêm hướng dẫn lấy `TELEGRAM_BOT_TOKEN` (nhắn @BotFather, `/newbot`) và `TELEGRAM_CHAT_ID` (gọi `getUpdates` hoặc dùng @userinfobot).
- **Cố tình KHÔNG đụng vào chatbot Q&A** (`src/server/`, dùng `QaDebate.ts` riêng, không dùng `AgentOrchestrator`) — yêu cầu của boss xuất phát từ ngữ cảnh benchmark build phần mềm đang thất bại, nên giới hạn đúng phạm vi đó; có thể mở rộng sang chatbot sau nếu boss muốn.

**Bằng chứng:** `npm run compile`/`lint` sạch. Test mới: `test/unit/telegramNotifierService.test.js` (5 ca — không cấu hình thì no-op+cảnh báo đúng 1 lần, gửi đúng nội dung tới 1 HTTP server giả cục bộ, gửi tuần tự đúng thứ tự không bị đua, lỗi HTTP 401 báo qua `onWarn` thay vì throw, tin nhắn dài bị cắt đúng giới hạn), `test/unit/loadEnvFile.test.js` (5 ca), cộng 2 ca tích hợp trong `test/orchestrator.test.js` xác nhận `_setPhase`/`_emit('error', ...)` thật sự gọi `telegram.notify(...)` với nội dung đúng, và không throw khi chưa cấu hình. `npm test`: **342/342 pass** (330 từ trước + 12 test mới của Telegram/loadEnvFile/tích hợp orchestrator), lint sạch.

**Chưa làm/còn tồn đọng:**
- ~~Boss chưa nhắn cho bot nên chưa có `TELEGRAM_CHAT_ID`~~ — **đã xong (2026-09-18)**: boss nhắn `/start` cho bot, lấy được `chat.id=6704086340` qua `getUpdates`, điền vào `.env`, gửi thử 1 tin xác nhận qua `sendMessage` thành công (`ok:true`, boss nhận được). Telegram notification đã sẵn sàng hoạt động thật cho lần chạy tiếp theo.
- Chưa thêm cấu hình bật/tắt trong `.agent-workspace/model_config.json` — cố ý, vì file đó được git-track (không phù hợp chứa gợi ý bật/tắt gắn với secret nằm ở nơi khác); nếu boss muốn tắt tạm thời mà không xoá `.env`, cần bàn thêm cách làm (biến môi trường phụ, hoặc 1 cờ riêng không phải secret).
- Chưa mở rộng Telegram sang chatbot Q&A (`src/server/`) — ngoài phạm vi yêu cầu lần này.
- Chưa chạy lại benchmark `test:e2e:brick-breaker` để xác nhận cả 2 việc (fix binary-asset + Telegram) cùng hoạt động đúng trong 1 lần chạy thật — theo đúng yêu cầu "chưa chạy lại" của boss.

### 2026-09-18 (tiếp) — Thiếu dispatcher thật: đội hình chuyên biệt do AgentFactory thiết kế chỉ tranh luận, không code — đã sửa để tự động định tuyến task cho đúng specialist

Boss hỏi: có cơ chế điều phối nào gán đúng agent cho đúng việc không, tránh phân công sai? Đã cho 1 agent đọc kỹ code (không đoán) để trả lời chính xác trước khi sửa gì.

**Hiện trạng phát hiện được (trước khi sửa):** Hoàn toàn KHÔNG có dispatcher. Field `TaskItem.assignedAgent` tồn tại nhưng chỉ là 1 trong 11 role cố định của pipeline (`codeWorker`, `fixer`, ...), không phải domain chuyên môn, và **không hề được dùng để định tuyến** — `_executeCodeWorker` luôn gọi `_agentConfig('codeWorker')`, tức đúng 1 model cố định (`qwen2.5-coder:14b-instruct` theo config mặc định) viết TOÀN BỘ code của mọi task, bất kể task đó thuộc mảng nào. Cơ chế "5 agent chuyên biệt tranh luận" (`AgentFactory`/`DynamicTeam`, đúng tinh thần CLAUDE.md) chỉ chạy 4 vòng tranh luận để CHỌN PHƯƠNG ÁN — sau khi có kết quả, `_seedBuildFromTeam` chuyển toàn bộ quyết định thành văn bản rồi giao lại cho pipeline cố định, đội hình chuyên biệt (kể cả persona "Builder" — người lẽ ra phụ trách "execution & implementation") bị bỏ hoàn toàn, không viết dòng code nào.

Boss chọn hướng: làm cho đội hình chuyên biệt thật sự tham gia code (không chỉ nhẹ theo specialty-router), đúng tinh thần CLAUDE.md.

**Đã sửa (đủ để mọi task được lập kế hoạch có thể route đúng specialist, nhưng KHÔNG viết lại toàn bộ pipeline — xem "Chưa làm" bên dưới):**
1. `src/types.ts`: thêm `TaskItem.specialistId?: string` — id của 1 thành viên trong `dynamic_team_plan.json` (đã có sẵn từ trước, do `AgentFactory` ghi ra khi thiết kế đội hình) sở hữu task đó. Không đụng `assignedAgent` (giữ nguyên vai trò pipeline cũ) để không phá vỡ toàn bộ chỗ khác đang dùng type `AgentRole` cố định.
2. `src/prompts/agentPrompts.ts` (`TASK_MANAGER_SYSTEM`): khi context có mục "# Specialist Team Roster", task-manager phải gán `specialistId` cho task nào khớp rõ chuyên môn 1 specialist; bỏ trống nếu không khớp; không được tự bịa id.
3. `src/orchestrator/AgentOrchestrator.ts`:
   - `_phaseTaskPlanning`: đọc `dynamic_team_plan.json` của ĐÚNG run hiện tại (tái dùng `_readCurrentDynamicTeam`, đã validate goal + timestamp từ trước), đưa roster (id/tên/chuyên môn/mission từng specialist) vào context cho task-manager.
   - `_normalizeTaskItem`: chỉ tin `specialistId` nếu nó thật sự là 1 id có trong roster của run hiện tại; id lạ/bịa bị loại bỏ + ghi assumption rõ ràng, task quay về dùng codeWorker chuẩn — không bao giờ route nhầm sang agent không tồn tại.
   - `_executeCodeWorker` và `_executeFixer`: nếu task có `specialistId` hợp lệ, gọi ĐÚNG model của specialist đó (`model`/`fallbackModel` riêng, khác codeWorker mặc định) thay vì model cố định; hệt vậy khi task đó cần fix lại (cùng 1 specialist theo task từ đầu đến cuối, không đổi giữa chừng). Test-fix task tổng hợp (`test-fix-*`, không thuộc task gốc nào) không có `specialistId` nên không bị ảnh hưởng, giữ nguyên logic escalate-model cũ.
   - `_buildMessages`: thêm tham số specialist tuỳ chọn — CHỈ chèn thêm đoạn "SPECIALIST ASSIGNMENT: tên/chuyên môn/mission" lên TRÊN system prompt gốc của codeWorker/fixer, không thay thế. Cố tình không dùng nguyên văn `systemPrompt` tự do mà AgentFactory sinh cho specialist đó (viết cho tranh luận mở, không phải cho output JSON chặt schema) — tránh việc thay hẳn system prompt làm hỏng format files[]/JSON bắt buộc mà orchestrator cần parse.
   - Reviewer/quality-audit **cố tình giữ nguyên** (không route theo specialist) — để việc review vẫn là 1 model độc lập với người viết code, giữ đúng giá trị "kiểm tra chéo" thay vì specialist tự duyệt bài của chính mình.
4. Test mới trong `test/orchestrator.test.js` (7 ca): roster xuất hiện trong context task-manager khi có team plan hợp lệ / không xuất hiện khi không có; `specialistId` hợp lệ được giữ, id bịa bị loại + ghi assumption; `_executeCodeWorker` và `_executeFixer` gọi đúng model của specialist + có framing "SPECIALIST ASSIGNMENT", còn task không có specialist thì vẫn dùng model codeWorker mặc định như cũ.

**Bằng chứng:** `npm run compile`/`lint` sạch. `test/orchestrator.test.js`: **82/82 pass**. `npm test` (toàn bộ suite): **349/349 pass** (342 trước đó + 7 test mới).

**Chưa làm/còn tồn đọng (cố ý để dành, không tự ý mở rộng thêm):**
- Đây là bước ĐẦU của "đội hình chuyên biệt thật sự code" — vẫn là planning tập trung (briefBuilder → architect → taskManager không đổi), chỉ có bước THI CÔNG (coding/fixing) được định tuyến theo specialist. Chưa làm: để chính các specialist tự chia việc/tranh luận cách chia task (thay vì taskManager 1 model quyết định gán id), và chưa cho specialist dùng nguyên bộ `tools`/`systemPrompt` đầy đủ mà AgentFactory thiết kế cho họ (mới dùng name/specialty/mission, chưa dùng systemPrompt tự do hay tools riêng).
- Reviewer/quality-audit chưa route theo specialist (ví dụ để "Critic"/"Verifier" persona tự tay review đúng phần việc mình phụ trách) — quyết định có chủ đích giữ nguyên trong đợt này để không mất tính độc lập của bước review; có thể bàn thêm nếu boss muốn "Critic" persona thật sự làm reviewer.
- **Chưa chạy benchmark thật** (`test:e2e:brick-breaker` hoặc goal khác) để xác nhận việc định tuyến specialist hoạt động đúng với model thật, đúng theo yêu cầu "chưa chạy lại" của boss ở phần trên.

### 2026-09-18 (tiếp nữa) — Boss yêu cầu "làm luôn phần lập kế hoạch": mở rộng định tuyến specialist sang briefing/architecture/task-planning

Tiếp nối mục ngay trên — mới chỉ định tuyến bước THI CÔNG (coding/fixing) theo specialist, phần LẬP KẾ HOẠCH (brief → architecture → task plan) vẫn dùng model cố định. Boss yêu cầu làm nốt phần này.

**Đã sửa** (`src/orchestrator/AgentOrchestrator.ts`):
- Thêm `_specialistForPlanningRole(role, state)`: khi run này có đội hình do AgentFactory thiết kế, map 3 role kế hoạch cố định sang đúng `teamRole` chuyên trách sẵn có trong đội hình — `architect` → specialist có `teamRole: 'architect'` (đúng người đã tranh luận và thắng phương án, giờ tự tay hoàn thiện văn bản kiến trúc, giữ nhất quán giọng điệu/lý do thay vì giao cho 1 model khác đọc lại từ đầu); `briefBuilder` → `teamRole: 'strategist'` (fallback `researcher`); `taskManager` → `teamRole: 'strategist'` (đúng mission "planning & decomposition"). `AgentFactory._ensureMandatoryCoverage()` đã đảm bảo 6 teamRole bắt buộc luôn có mặt trong mọi đội hình được thiết kế, nên hầu như luôn tìm được người phù hợp khi có đội hình.
- `_phaseBriefing`, `_phaseArchitecture`, `_phaseTaskPlanning`: mỗi phase tự tra `_specialistForPlanningRole` tương ứng; nếu có specialist khớp thì gọi đúng model/fallback của specialist đó (khác model brief-builder/architect/task-manager mặc định), kèm framing "SPECIALIST ASSIGNMENT" (dùng lại đúng cơ chế `_specialistFraming`/`_buildMessages` đã xây cho coding/fixing) — không đổi bất kỳ rule/schema output nào của các role này. Không có đội hình (chạy theo debate 4 vòng cố định cũ, hoặc goal maintenance skip debate) → hành vi y hệt trước, không đổi.
- Đổi tên nhẹ: `_specialistFraming` giờ dùng chữ trung lập "this specific piece of work" thay vì "this specific implementation task" — áp dụng đúng cho cả việc lập kế hoạch lẫn việc code.
- 4 test mới trong `test/orchestrator.test.js`: architecture/brief/task-planning đều gọi đúng model specialist tương ứng khi có đội hình + có đoạn "SPECIALIST ASSIGNMENT" trong system prompt; và vẫn dùng model cố định như cũ khi không có đội hình.

**Bằng chứng:** `npm run compile`/`lint` sạch. `test/orchestrator.test.js`: **86/86 pass** (82 trước đó + 4 test mới). `npm test` (toàn bộ suite): **353/353 pass** (349 trước đó + 4 test mới).

**Chưa làm/còn tồn đọng:**
- Vẫn CHỈ 1 specialist/phase làm việc (ví dụ 1 mình "architect" viết tài liệu kiến trúc) — chưa có việc các specialist debate/kiểm tra chéo NGAY TRONG từng phase kế hoạch (khác với 4 vòng debate ban đầu vốn đã có kiểm tra chéo để CHỌN hướng đi; đây là formalize hướng đã chọn thành văn bản/kế hoạch cụ thể).
- ~~Chưa chạy benchmark thật~~ — **đã chạy (2026-09-18), xem mục ngay dưới.**

### 2026-09-18 (tiếp nữa nữa) — Chạy lại benchmark thật: xác nhận planning-specialist routing hoạt động đúng trong thực tế, nhưng lộ ra 1 bug MỚI (khác hôm qua) gây fail lần nữa — đã sửa

Boss yêu cầu "chạy lại benchmark". Chạy `npm run test:e2e:brick-breaker` với đầy đủ các sửa hôm nay (fix binary-asset, Telegram, specialist dispatch cho coding/fixing + planning). Workspace: `demo/brick-breaker-20-2026-09-18T00-26-00-687Z`.

**Kết quả: chạy sạch ~97 phút, 50 lượt gọi model, 0 lỗi transport — nhưng vẫn FAIL: 0/30 task hoàn thành.** Cảnh báo đầu run: chỉ 16.5% RAM trống (5.4GB/32GB, do OneDrive + Edge + 1 máy ảo + Docker cùng chạy) — không phải nguyên nhân fail lần này (không có dấu hiệu OOM/silent death), nhưng vẫn là rủi ro tiềm ẩn đã ghi nhận từ trước.

**Xác nhận tích cực: specialist routing cho PLANNING hoạt động đúng như thiết kế** — log thật: `Project brief routed to team specialist "Ava Nguyen" (qwen2.5-coder:7b-instruct)`, `Architecture routed to team specialist "Sophia Lee" (deepseek-coder-v2:16b)`, `Task planning routed to team specialist "Ava Nguyen" (...)`. Đây là bằng chứng sống đầu tiên rằng tính năng "đúng agent đúng việc" hôm nay build ra thật sự chạy được, không chỉ pass unit test.

**Nhận xét phụ (chưa phải lỗi):** không có task nào trong 30 task được gán `specialistId` (tất cả `None`) — nghĩa là dù roster đặc tả rõ ràng trong context, model đóng vai task-manager (7B, "Ava Nguyen") không tận dụng tính năng gán specialist cho coding. Không phải bug (cơ chế additive, không gán thì dùng lại codeWorker mặc định như cũ) — nhưng đáng theo dõi: có thể do model 7B chưa đủ mạnh để tuân thủ hướng dẫn phức tạp này, cần thêm vài lần chạy mới kết luận được xu hướng.

**Root cause KHÁC hôm qua, đã xác định qua `task_plan.json`:** Lần này task-manager tự tạo ra một sprint 30 task (khác 5 task hôm qua) — không còn binary asset nào (fix hôm qua có hiệu lực), nhưng task-001 có acceptance criteria: `"All required files are present and empty"` — **trực tiếp mâu thuẫn với chính rule 9 trong `TASK_MANAGER_SYSTEM` prompt** ("Do not assign empty source files... as completed implementation work") mà model này đang chạy dưới prompt đó. Dù code worker làm gì, heuristic "file is empty" (đúng đắn, có lý do chính đáng từ lịch sử) đều chặn giống hệt nhau ở mọi lần fix → lại trúng đúng cơ chế chống lặp vô hạn → fail toàn bộ 30 task vì 1 task-001 không thể nào thoả mãn đồng thời "để trống" và "không được để trống".

**Đã sửa (`src/orchestrator/AgentOrchestrator.ts`, `src/prompts/agentPrompts.ts`):**
1. Thêm `_reconcileEmptyFileAcceptanceCriteria(taskId, acceptanceCriteria)` — quét tất định (regex, không cần model) mọi acceptance criteria có dạng "file(s) ... empty/blank" hoặc ngược lại; nếu khớp, GIỮ NGUYÊN câu gốc (tránh cắt xén làm sai lệch ý khác nếu có) nhưng THÊM 1 criterion mới yêu cầu rõ "mọi file trong allowedFiles phải có nội dung thật, tối thiểu, hoạt động được — không bao giờ là file 0 byte thật sự", đồng thời ghi assumption rõ ràng. Gọi ngay trong `_normalizeTaskItem`, nên áp dụng cho MỌI task plan, không riêng gì brick-breaker.
2. Tăng cường rule 9 trong `TASK_MANAGER_SYSTEM` (`agentPrompts.ts`): nói rõ cấm viết acceptance criteria mô tả file là "empty"/"blank"/placeholder-only — phòng ngừa ở tầng prompt (best-effort) song song với chặn tất định ở #1 (luôn đáng tin hơn).
3. 2 test mới: tái hiện đúng ca thật (criteria "All required files are present and empty" → được reconcile đúng, có assumption); và 1 test đảm bảo không báo nhầm cho câu dùng từ "empty" hợp lệ khác ngữ cảnh (ví dụ "input field is empty").

**Bằng chứng:** `npm run compile`/`lint` sạch. `test/orchestrator.test.js`: **88/88 pass** (86 trước đó + 2 test mới). `npm test` (toàn bộ suite): **355/355 pass** (353 trước đó + 2 test mới).

**Chưa làm/còn tồn đọng:**
- **Chưa chạy lại benchmark lần 3** để xác nhận cả bug hôm nay lẫn bug hôm qua đều đã hết — cần hỏi boss trước khi chạy thêm 1 lượt ~100 phút nữa (theo đúng tinh thần "chưa chạy lại" trừ khi được yêu cầu).
- RAM 16.5% free lúc bắt đầu run vẫn là rủi ro treo/OOM tiềm ẩn (dù lần này không xảy ra) — nếu muốn tăng độ ổn định cho lần chạy tiếp theo, nên đóng bớt Edge/Docker/máy ảo trước khi chạy.
- Chưa điều tra sâu vì sao task-manager 7B không dùng `specialistId` dù có roster — có thể cần vài lần chạy nữa hoặc thử model task-manager mạnh hơn để có kết luận.

### 2026-09-19 — Chạy lại benchmark lần 3: fail lần nữa, 2 nguyên nhân — 1 bug thật của model (task-008), 1 khả năng TÁI DIỄN bug Swift/Package.swift đã tưởng sửa ngày 11/9 qua 1 CƠ CHẾ KHÁC — ghi lại để điều tra/sửa sau, CHƯA SỬA

Chạy `npm run test:e2e:brick-breaker` nền (`nohup ... & disown`, PID 67469), workspace `demo/brick-breaker-20-2026-09-19T03-14-53-651Z`, log đầy đủ `/private/tmp/debate-brick20-20260919-101451.log`. RAM lúc bắt đầu chỉ 6.9% free (2254MB/32768MB, do OneDrive+VM+Edge+Word) — thấp hơn cả lần chạy 16.5% free trước, nhưng lần này không có dấu hiệu OOM/SIGBUS. Boss yêu cầu dừng test giữa chừng; kiểm tra lại thì thấy tiến trình đã tự kết thúc (fail) lúc `2026-09-19T09:00:29Z`, trước cả khi lệnh dừng được gửi.

**Tích cực — cả 2 fix ngày 18/9 giữ vững qua lần chạy này:** không còn binary asset nào trong task plan, không còn acceptance criteria "file phải trống" chặn nhầm. Specialist routing cho cả planning (brief/architecture/task-planning) và coding/fixing đều hoạt động đúng — log thật: `Project brief routed to team specialist "Level Designer" (qwen2.5-coder:7b-instruct)`, `Architecture routed to team specialist "System Architect" (deepseek-coder-v2:16b)`; mọi task 002-008 và các lần fix của chúng đều routed đúng tới `"Game Builder" (qwen2.5-coder:14b-instruct)`. 7/20 task hoàn thành (project structure → brick collision) trước khi dừng ở task-008 — tiến xa hơn 2 lần chạy trước (5 task và 0 task).

**Nguyên nhân fail #1 — lỗi code thật của model, không phải bug hạ tầng:** `sprint-01-task-008` ("Implement score tracking") fail sau đúng 8/8 lần sửa. `task_plan.json` ghi lỗi cuối: `[quality] The collision detection function is incomplete and contains a syntax error (b.sta instead of b.status), which will cause a runtime error.` — model (`qwen2.5-coder:14b-instruct`, escalate `devstral-small-2` ở vòng test-fix cuối) liên tục không tự sửa được 1 typo mà reviewer đã chỉ đúng nhiều lần. 12 task còn lại (009-020) bị skip vì phụ thuộc task-008 — đúng thiết kế an toàn hiện có (không giao sản phẩm rỗng).

**Nguyên nhân fail #2 — khả năng tái diễn bug Swift đã tưởng sửa (finding #10, mục 2026-09-11 phía trên), nhưng qua cơ chế KHÁC, chưa điều tra kỹ:** Sau khi task-008 fail + 12 task bị skip, pipeline chuyển sang `testing`, chạy `npm test` — fail ngay (hợp lý, game/test chưa hoàn chỉnh). Nhưng bộ check cuối cùng bị kẹt vĩnh viễn ở **`npm test, swift test`**. Soi log: `Package.swift` KHÔNG nằm trong `allowedFiles` gốc của bất kỳ task 001-008 nào — file này xuất hiện lần đầu do chính **test-fixer tự tạo ra** ở vòng sửa test đầu tiên (`07:41:11 [warn] Task test-fix-1 expanded allowedFiles for fixer: Package.swift.`), sau đó `swift test` trở thành 1 trong 2 check bắt buộc suốt 8 lần sửa test còn lại — dù đây là project JS/Phaser 100%, brief/architecture không hề nhắc Swift. Khác finding #10 cũ (bị injected 1 "TOOLCHAIN CONSTRAINT" giả vào context ngay từ đầu vì `_phaseToolchainDiscovery` thấy Swift CLI cài trên máy — đã gate bằng `_targetsNativeApplePlatform()`): lần này `Package.swift` có vẻ do MODEL tự hallucinate ra khi cố "sửa" 1 test đang fail, và cơ chế xác định check-command (chưa xác định được chính xác hàm nào — cần grep `AgentOrchestrator.ts` khu vực `_phaseTesting`/quyết định test-command) coi sự TỒN TẠI của `Package.swift` trên đĩa là đủ để bắt buộc chạy `swift test`, bất kể ai/cái gì tạo ra file đó lúc nào. Tạo thành vòng lặp tự hại: model tạo 1 file Swift không hoàn chỉnh → hệ thống ép chạy `swift test` như 1 check bắt buộc → không bao giờ pass → đốt hết 8/8 lần sửa test còn lại vào 1 vấn đề tự tạo — cùng HỌ lỗi với finding #10 nhưng qua đường khác (file-existence-based detection tại thời điểm TEST, không phải context-injection tại thời điểm THIẾT KẾ TOOLCHAIN).

**Bằng chứng:** `task_plan.json` của workspace trên; `find demo/brick-breaker-20-2026-09-19T03-14-53-651Z -iname Package.swift` xác nhận file tồn tại thật trên đĩa cuối run; log đầy đủ `/private/tmp/debate-brick20-20260919-101451.log`. Thời điểm fail cuối `2026-09-19T09:00:29.120Z`; tổng thời gian chạy ~5h45m (heartbeat cuối 20701s) — dài hơn nhiều so với các lần chạy trước (~1h40m), chủ yếu do 8 lần sửa task-008 (vài phút tới >10 phút/lần) cộng 8 lần sửa test ở cuối.

**Chưa làm/còn tồn đọng (ghi lại để điều tra/sửa sau, theo đúng yêu cầu boss "chưa fix vội"):**
- Chưa grep code để xác định chính xác hàm nào trong `AgentOrchestrator.ts` quyết định thêm `swift test` vào check list dựa trên sự tồn tại của `Package.swift` trên đĩa — cần biết đây có dùng lại `_targetsNativeApplePlatform()` (finding #10) hay là 1 đường hoàn toàn khác (ví dụ quét file thật trong `_phaseTesting` để suy ra test-command).
- Hướng sửa khả dĩ (chưa quyết, chưa code): (a) chặn model tạo file toolchain-marker (`Package.swift`, `Cargo.toml`, `pom.xml`, ...) không khớp `chosenStack`/`targetPlatforms` của brief — cùng tinh thần `isBinaryAssetPath()` (fix ngày 18/9) nhưng cho "file toolchain sai nền tảng" thay vì "binary asset"; hoặc (b) chỉ tin file toolchain-marker do chính task lúc coding ban đầu tạo ra, không tin file do TEST-FIXER tự thêm giữa chừng khi cố sửa lỗi test.
- Task-008 (`b.sta` vs `b.status`) là 1 ca cụ thể của vấn đề rộng hơn: model 8 lần sửa không tự bắt được 1 typo rõ ràng dù reviewer chỉ đúng nhiều lần — có thể do chưa được cho xem đủ ngữ cảnh, hoặc `qwen2.5-coder:14b-instruct` (Game Builder) không đủ mạnh cho debug tinh vi kiểu này; escalate sang `devstral-small-2` hiện chỉ có ở vòng test-fix cuối, không có ở vòng fix theo từng task riêng — có thể cần escalate sớm hơn.
- Chưa chạy benchmark lần 4 — cần quyết định hướng sửa ở trên trước.

### 2026-09-26 — Sửa 2 nguyên nhân fail của benchmark lần 3 (19/9) + commit checkpoint

Boss yêu cầu "làm hết". Đã commit toàn bộ việc tồn đọng từ 11–19/9 (`4863be8`; `demo/brick-breaker-*`, `demo/word-addin-refs-*` giờ được gitignore — 678MB output benchmark). Lưu ý: `node_modules/.bin/*` bị OneDrive biến symlink thành file text nên `npm run compile` hỏng — chạy trực tiếp `node node_modules/typescript/bin/tsc -p ./` (hoặc `npm ci` để tạo lại).

**Fix #1 — `Package.swift` do model bịa ra ép chạy `swift test` trong project JS.** Nguồn: `VerificationPlanner` (`src/services/verificationPlanner.ts`) biến sự tồn tại của file manifest thành check bắt buộc. Sửa ở gốc (không để file lọt xuống đĩa):
- `toolchainMarkerStack()` / `stackTextMentions()` (`src/utils/moduleContracts.ts`): nhận diện `Package.swift`, `Cargo.toml`, `go.mod`, `pom.xml`/gradle, `*.csproj`/`*.sln` và stack tương ứng.
- `_isOffStackToolchainMarker()` (`AgentOrchestrator.ts`): manifest MỚI (chưa tồn tại) mà brief `chosenStack`/`targetPlatforms`/prompt không nhắc tới stack đó → off-stack. File có sẵn (repo của user) và run chưa có brief thì luôn được tin.
- Áp dụng ở 2 chỗ: `_normalizeTaskItem` (loại khỏi `allowedFiles` lúc lập kế hoạch) và `_dropOffStackToolchainMarkers` gọi đầu `_selfHealAllowedFiles` (bỏ riêng file đó khỏi output của codeWorker/fixer/test-fixer, giữ các file tốt còn lại). Ghi assumption + log warn.

**Fix #2 — task-008 sửa 8/8 lần không xong typo `b.sta`.** Trước đây chỉ `test-fix-*` không có specialist mới escalate model. Giờ trong `_executeFixer`: từ lần sửa thứ 3 (`FIX_ESCALATION_ATTEMPT`), MỌI task (kể cả task của specialist) chuyển sang `fixer.fallbackModel` (mặc định `devstral-small-2`), model gốc làm fallback, vẫn giữ persona specialist. Thêm: bộ chặn "no progress" (dừng sau 2 lần lỗi y hệt) giờ escalate sang model mạnh 1 lần trước khi bỏ cuộc (`escalatedFixTasks`).

**Mục 5.1 cũ (dependency install không retry):** thực tế đã được làm trước đó (`_phaseDependencyInstall` có vòng fix, `test/dependencyInstall.test.js`) — mục 5 chưa cập nhật.

**Bằng chứng:** compile + lint sạch; `npm test` **363/363 pass** (355 + 8 test mới: 2 unit moduleContracts, 3 off-stack manifest, 3 escalation).

### 2026-09-26 (tiếp) — Benchmark lần 4 chết sau ~2 phút vì OneDrive/ổ đĩa, KHÔNG phải lỗi code agent

Chạy `node test/brick_breaker_e2e.js` nền (`nohup ... & disown`, PID 43873), workspace `demo/brick-breaker-20-2026-09-25T19-54-45-843Z`, log `/private/tmp/debate-brick20-20260926-025445.log`. Mục đích: xác nhận 2 fix ở mục trên (`815ff86`).

**Diễn biến:** preflight OK (`5 distinct local models are responsive`), vào `brainstorm` (meta-agent thiết kế team) lúc `19:56:35Z` rồi chết ngay: `Error: EACCES: permission denied, mkdir '.../26 Debate_agent/dist/benchmarks'` (tại `test/brick_breaker_e2e.js:61`, hàm `report`, khi ghi báo cáo lỗi). Workspace chỉ kịp tạo `AGENT_JOURNAL.md`. Ngay sau đó toàn bộ thư mục dự án **biến mất tạm thời** — shell báo "working directory no longer exists", Read tool báo "File does not exist". Một lúc sau thư mục quay lại nguyên vẹn (2 commit `4863be8`, `815ff86` còn đủ), nhưng 108 file hiện "modified" trong git **chỉ do đổi mode** (`git -c core.fileMode=false status` sạch) — dấu hiệu OneDrive đã gỡ/tải lại (re-materialize) thư mục.

**Kết luận:** fail do môi trường — OneDrive tạm thời thu hồi quyền truy cập thư mục dự án giữa run. Không có bằng chứng nào về 2 fix mới (run chết trước khi có task plan). Lỗi gốc có thể đã xảy ra sớm hơn ở pipeline (lỗi ghi file của meta-agent), còn `EACCES` là lỗi ở bước ghi báo cáo — log không đủ để phân biệt vì chính thư mục bị mất.

**Các lỗi môi trường do OneDrive gây ra (tổng hợp):**
1. `node_modules/.bin/*` bị biến từ symlink thành file text 21 byte → `npm run compile`, `npm run test:e2e:*` hỏng (`../typescript/bin/tsc: No such file or directory`). Tạm thời gọi trực tiếp `node node_modules/typescript/bin/tsc -p ./`.
2. Mode file bị đổi hàng loạt (644 → 755/700) → git báo hàng trăm file "modified" giả. Tạm thời dùng `git -c core.fileMode=false ...` khi add/commit.
3. Thư mục dự án mất quyền truy cập/biến mất giữa run dài → giết benchmark lần 4 (EACCES).
4. OneDrive chiếm ~2.9GB RAM trong lúc benchmark (cùng VM ~2.2GB) → app báo chỉ 2.7% RAM free lúc khởi động (dù OS memory pressure "normal").

**Việc cần làm (chưa làm):**
- Chuyển dự án (hoặc ít nhất `node_modules/`, `demo/`, `dist/`) ra khỏi thư mục OneDrive, ví dụ `~/Projects/debate-agent`, hoặc tạm dừng đồng bộ OneDrive khi chạy benchmark. Sau đó `npm ci` để tạo lại `node_modules/.bin`.
- Cân nhắc `git config core.fileMode false` cho repo này nếu vẫn để trong OneDrive.
- Chạy lại benchmark lần 4 sau khi xử lý môi trường — 2 fix `815ff86` vẫn CHƯA được xác nhận trên model thật.

### 2026-09-26 (tiếp nữa) — Xử lý môi trường sau khi boss dừng đồng bộ OneDrive + chạy lại benchmark lần 4

- `npm ci`: tạo lại `node_modules/.bin` (trước đó symlink bị OneDrive biến thành file text, kèm bản trùng `* 2`). `npm run compile` chạy lại bình thường. Không tìm thấy file trùng `* 2` nào trong source.
- `git config core.fileMode false` cho repo → hết hàng trăm file "modified" giả do đổi mode.
- `test/brick_breaker_e2e.js`: `report()` (gọi mỗi 60s từ heartbeat) giờ bắt lỗi ghi file và chỉ log `[warn]` — trước đây 1 lỗi ghi tạm thời (EACCES như lần 4) ném exception trong `setInterval` và giết cả run nhiều giờ.
- `npm run check`: 363/363 pass. RAM: memory_pressure 87% free.
- Chạy lại benchmark: PID 54822, log `/private/tmp/debate-brick20-20260926-055153.log`.

### 2026-09-26 (tiếp) — Kết quả run 4 (chạy lại) + sửa lỗi mới + chạy run 5

**Run 4 (PID 54822, `demo/brick-breaker-20-2026-09-25T22-51-53-153Z`), ~2h40m, dừng chủ động:**
- Tích cực: không lỗi môi trường; 4 vòng debate đủ; lần đầu task-manager gán `specialistId` cho task (002–005); planning routing đúng; **fix #2 (`815ff86`) xác nhận live**: `Repeated repair of "sprint-01-task-003" is being escalated from qwen2.5-coder:14b-instruct to devstral-small-2`.
- Lỗi mới: task-003 gộp 21 file (`level1..20.js` + `index.js`). Mọi call 14B/devstral cho task này timeout 600s; chỉ retry compact-context bằng 7B thành công nhưng viết "add more…" → review chặn đúng → không bao giờ pass. Thêm: quality-audit đòi tạo đủ level1..20.js dù đó chỉ là file *được phép*.
- Sửa (`724d904`): `_splitOversizedTasks` (tất định, gọi sau `_normalizeTaskItem`) chia task >6 file thành các phần tuần tự (part cuối giữ id gốc + acceptance criteria gốc + file aggregator `index/main/app.*`); rule 2 `TASK_MANAGER_SYSTEM`: tối đa 6 file/task, nhiều item giống nhau gom vào 1 file dữ liệu; prompt quality-audit: allowed files là "được phép", không phải "bắt buộc". `npm run check` 364/364.
- Dừng run 4 (SIGTERM) vì tiến trình chạy code cũ, task-003 chắc chắn fail. Chạy run 5: PID 69856, log `/private/tmp/debate-brick20-20260926-083148.log`.
- Fix #1 (off-stack `Package.swift`) vẫn chưa được kiểm chứng live (chỉ xuất hiện ở pha testing).

### 2026-09-26 (tiếp) — Run 5 chết vì OneDrive (dù đã dừng sync) → chạy benchmark trên ổ trong

- Run 5 (`/private/tmp/debate-brick20-20260926-083148.log`) chết sau ~19 phút ở vòng debate 2: thư mục dự án lại biến mất → `EACCES` trong `RunLock.heartbeat` (gọi từ `setInterval`) → uncaught exception. Dừng sync là không đủ.
- Sửa: `RunLock.heartbeat()` nuốt lỗi ghi (lỡ 1 nhịp chỉ làm lock trông stale sớm hơn, nhịp sau ghi lại). Test mới trong `test/autonomousResume.test.js`.
- Theo đề xuất của boss: `scripts/run-on-internal-disk.sh` (`npm run test:e2e:brick-breaker:local`) — dữ liệu chính vẫn ở Data; khi chạy thì copy repo sang `~/.debate-agent-runs/<id>` (bỏ node_modules/out/demo/dist/.git), `npm ci` + compile, chạy job, sửa đường dẫn tuyệt đối trong report JSON, chờ thư mục Data khả dụng (tối đa 240 phút), copy `demo/` + `dist/` về (bỏ `node_modules` của project sinh ra), kiểm tra từng file bằng `cmp`, chỉ xoá bản ổ trong khi đã xác minh đủ. Log run: `dist/local-runs/<id>.log`.
- `npm run check` 365/365.

### 2026-09-26 (tiếp) — Run 6 (chạy trên ổ trong): sprint 1 xong 6/6 task lần đầu, fail ở smoke test → 3 fix mới

Run 6 chạy qua `scripts/run-on-internal-disk.sh`: ~2h35m, không lỗi môi trường. Copy-back thành công: workspace `demo/brick-breaker-20-2026-09-26T02-15-54-990Z`, log `dist/local-runs/20260926-091547.log`, bản trên ổ trong đã xoá.

- **Tích cực:** chia task chạy đúng trên model thật (task-001 7 file → 2 phần); **6/6 task sprint 1 hoàn thành** (lần đầu một sprint xong trọn vẹn); escalate sang devstral hoạt động ở cả pha fix task lẫn pha test-fix; không có `Package.swift`.
- **Fail:** `app smoke verification` sau 8/8 lần test-fix — `SyntaxError: Cannot use import statement outside a module`.
- **Nguyên nhân 1:** task-manager đặt `src/package.json` + `src/README.md` (nội dung là manifest gốc) → dependency install "No package.json found", Phaser không được cài. **Sửa (`182b073`)**: `_hoistMisplacedRootManifests` — manifest (`package.json`, `README.md`, `requirements.txt`, `pyproject.toml`) ngay dưới `src/` của project mới được chuyển lên gốc (kể cả trong mô tả/criteria); file đã có sẵn thì giữ nguyên.
- **Nguyên nhân 2:** `index.html` (do test-fix-1 tạo, không task nào liệt kê) không bao giờ được đưa cho các fixer sau vì lỗi smoke không nêu tên file → 7 lần sửa file sai. **Sửa (`a78cd1e`)**: `_collectTestFixAllowedFiles` luôn gồm `index.html`/`public/index.html`/`src/index.html` nếu tồn tại.
- **Cải tiến (`b379b07`)**: chia task cân bằng (7 → 4+3, không phải 6+1).
- Ghi chú: sprint 1 chỉ có 6 task (không có 20 level) — sprint sau phải lo; chưa kiểm chứng.
- `npm run check` 369/369. Chạy run 7.
