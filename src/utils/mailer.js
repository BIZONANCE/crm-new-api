const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL,
    pass: process.env.PASSWORD,
  },
});

const BRAND = "BiZONANCE CRM";
const BRAND_COLOR = "#2563EB";
const YEAR = new Date().getFullYear();

// Publicly hosted logo URL — only used as a fallback if the local logo file
// below can't be found on the server.
const LOGO_URL = "https://crmapi.bizonance.com/public/bizonance_logo.png";

// The logo is attached to every email as an inline (CID) image, so it loads
// together with the email instead of being fetched from the server each
// time. Adjust LOGO_PATH if your public folder lives somewhere else — it
// should point at the same file express serves at /public/bizonance_logo.png.
const LOGO_PATH = path.join(__dirname, "..", "public", "bizonance_logo.png");
const LOGO_CID = "bizonance-logo@crm";
const HAS_LOCAL_LOGO = fs.existsSync(LOGO_PATH);

if (!HAS_LOCAL_LOGO) {
  console.warn(
    `mailer: logo not found at ${LOGO_PATH} — emails will load the logo from ${LOGO_URL} instead.`
  );
}

const LOGO_SRC = HAS_LOCAL_LOGO ? `cid:${LOGO_CID}` : LOGO_URL;

const logoAttachments = HAS_LOCAL_LOGO
  ? [
      {
        filename: "bizonance_logo.png",
        path: LOGO_PATH,
        cid: LOGO_CID,
        contentDisposition: "inline",
      },
    ]
  : [];

// Shared email shell
function buildEmail({ title, preheader, body }) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>${title}</title>
</head>

<body
  style="
    margin:0;
    padding:0;
    background-color:#F0F4F9;
    font-family:'Segoe UI',Arial,sans-serif;
  "
>
  <!-- Hidden preheader -->
  <div
    style="
      display:none;
      max-height:0;
      overflow:hidden;
      mso-hide:all;
    "
  >
    ${preheader}&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;
  </div>

  <table
    width="100%"
    cellpadding="0"
    cellspacing="0"
    border="0"
    style="
      background-color:#F0F4F9;
      padding:40px 16px;
    "
  >
    <tr>
      <td align="center">

        <table
          width="560"
          cellpadding="0"
          cellspacing="0"
          border="0"
          style="
            max-width:560px;
            width:100%;
          "
        >

          <!-- Brand -->
          <tr>
            <td
              align="center"
              style="
                padding-bottom:24px;
              "
            >
              <img
                src="${LOGO_SRC}"
                alt="${BRAND}"
                width="200"
                style="
                  display:block;
                  margin:0 auto;
                  max-width:200px;
                  height:auto;
                "
              />
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td
              style="
                background:#ffffff;
                border-radius:16px;
                overflow:hidden;
                box-shadow:0 2px 12px rgba(0,0,0,0.08);
              "
            >

              <!-- Email body -->
              <table
                width="100%"
                cellpadding="0"
                cellspacing="0"
                border="0"
              >
                <tr>
                  <td
                    style="
                      padding:36px 40px;
                    "
                  >
                    ${body}
                  </td>
                </tr>
              </table>

              <!-- Tricolor bottom bar -->
              <table
                width="100%"
                cellpadding="0"
                cellspacing="0"
                border="0"
              >
                <tr>

                  <td
                    width="33.33%"
                    style="
                      height:4px;
                      background:#F59E0B;
                      font-size:0;
                      line-height:0;
                    "
                  ></td>

                  <td
                    width="33.33%"
                    style="
                      height:4px;
                      background:#2563EB;
                      font-size:0;
                      line-height:0;
                    "
                  ></td>

                  <td
                    width="33.34%"
                    style="
                      height:4px;
                      background:#DC2626;
                      font-size:0;
                      line-height:0;
                    "
                  ></td>

                </tr>
              </table>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td
              align="center"
              style="
                padding-top:24px;
              "
            >
              <p
                style="
                  margin:0;
                  font-size:12px;
                  color:#9CA3AF;
                "
              >
                &copy; ${YEAR} ${BRAND} &middot; All rights reserved
              </p>

              <p
                style="
                  margin:6px 0 0;
                  font-size:12px;
                  color:#9CA3AF;
                "
              >
                If you didn't request this email, you can safely ignore it.
              </p>
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}


// Shared OTP block
function otpBlock(code, expiresInText) {
  return `
    <div
      style="
        margin:28px 0;
        text-align:center;
      "
    >
      <div
        style="
          display:inline-block;
          background:#F0F4F9;
          border:2px dashed #BFDBFE;
          border-radius:12px;
          padding:20px 40px;
        "
      >
        <span
          style="
            font-size:36px;
            font-weight:700;
            letter-spacing:10px;
            color:#1E40AF;
            font-family:'Segoe UI',Arial,sans-serif;
          "
        >
          ${code}
        </span>
      </div>

      <p
        style="
          margin:12px 0 0;
          font-size:13px;
          color:#EF4444;
          font-weight:600;
        "
      >
        ⏱ Expires in ${expiresInText}
      </p>
    </div>
  `;
}


// ─────────────────────────────────────────────────────────────────────────────
// Sign-in OTP
// ─────────────────────────────────────────────────────────────────────────────

async function sendOtpEmail(to, code) {
  const body = `
    <h2
      style="
        margin:0 0 8px;
        font-size:22px;
        font-weight:700;
        color:#111827;
      "
    >
      Your sign-in code
    </h2>

    <p
      style="
        margin:0 0 4px;
        font-size:15px;
        color:#6B7280;
      "
    >
      Use the code below to sign in to
      <strong style="color:#111827;">${BRAND}</strong>.
    </p>

    <p
      style="
        margin:0;
        font-size:13px;
        color:#9CA3AF;
      "
    >
      Do not share this code with anyone.
    </p>

    ${otpBlock(code, "2 minutes")}

    <table
      width="100%"
      cellpadding="0"
      cellspacing="0"
      border="0"
      style="
        background:#F8FAFC;
        border-radius:10px;
        margin-top:8px;
      "
    >
      <tr>
        <td
          style="
            padding:14px 18px;
          "
        >
          <p
            style="
              margin:0;
              font-size:13px;
              color:#6B7280;
              line-height:1.6;
            "
          >
            🔒 <strong>Never share this code.</strong>
            BiZONANCE will never ask for it.<br/>
            If you didn't request a code, someone may have typed your email by mistake.
          </p>
        </td>
      </tr>
    </table>
  `;

  await transporter.sendMail({
    from: `"${BRAND}" <${process.env.EMAIL}>`,
    to,
    subject: "Your BiZONANCE CRM sign-in code",

    text:
      `Your ${BRAND} sign-in code is ${code}. ` +
      `It expires in 2 minutes. ` +
      `Never share this code with anyone.`,

    html: buildEmail({
      title: "Your BiZONANCE CRM sign-in code",
      preheader:
        "Your one-time sign-in code for BiZONANCE CRM — expires in 2 minutes",
      body,
    }),

    attachments: logoAttachments,
  });
}


// ─────────────────────────────────────────────────────────────────────────────
// Invite / account activation
// ─────────────────────────────────────────────────────────────────────────────

async function sendInviteEmail(to, verifyUrl) {
  const body = `
    <h2
      style="
        margin:0 0 8px;
        font-size:22px;
        font-weight:700;
        color:#111827;
      "
    >
      You've been invited 🎉
    </h2>

    <p
      style="
        margin:0 0 20px;
        font-size:15px;
        color:#6B7280;
        line-height:1.6;
      "
    >
      Your Super Admin has added you to
      <strong style="color:#111827;">${BRAND}</strong>.
      Click the button below to verify your email and activate your account.
    </p>

    <table
      cellpadding="0"
      cellspacing="0"
      border="0"
      style="
        margin:28px 0;
      "
    >
      <tr>
        <td
          align="center"
          style="
            background:${BRAND_COLOR};
            border-radius:8px;
          "
        >
          <a
            href="${verifyUrl}"
            style="
              display:inline-block;
              padding:14px 32px;
              color:#ffffff;
              font-size:15px;
              font-weight:600;
              text-decoration:none;
              border-radius:8px;
              letter-spacing:0.3px;
            "
          >
            Verify Email &amp; Activate Account
          </a>
        </td>
      </tr>
    </table>

    <table
      width="100%"
      cellpadding="0"
      cellspacing="0"
      border="0"
      style="
        background:#F8FAFC;
        border-radius:10px;
        margin-top:8px;
      "
    >
      <tr>
        <td
          style="
            padding:14px 18px;
          "
        >
          <p
            style="
              margin:0;
              font-size:13px;
              color:#6B7280;
              line-height:1.6;
            "
          >
            Button not working?
            Copy and paste this link into your browser:<br/>

            <a
              href="${verifyUrl}"
              style="
                color:${BRAND_COLOR};
                word-break:break-all;
              "
            >
              ${verifyUrl}
            </a>
          </p>
        </td>
      </tr>
    </table>

    <p
      style="
        margin:20px 0 0;
        font-size:13px;
        color:#9CA3AF;
        line-height:1.6;
      "
    >
      After verifying, sign in with
      <strong>${to}</strong>
      using a one-time code —
      no password needed.
    </p>
  `;

  await transporter.sendMail({
    from: `"${BRAND}" <${process.env.EMAIL}>`,
    to,

    subject: "You've been invited to BiZONANCE CRM",

    text:
      `You've been added to ${BRAND}. ` +
      `Verify your email to activate your account: ${verifyUrl}`,

    html: buildEmail({
      title: "You've been invited to BiZONANCE CRM",
      preheader:
        "Verify your email to activate your BiZONANCE CRM account",
      body,
    }),

    attachments: logoAttachments,
  });
}


// ─────────────────────────────────────────────────────────────────────────────
// Pre-invite email verification OTP
// ─────────────────────────────────────────────────────────────────────────────

async function sendVerifyEmailOtp(to, code) {
  const body = `
    <h2
      style="
        margin:0 0 8px;
        font-size:22px;
        font-weight:700;
        color:#111827;
      "
    >
      Email verification code
    </h2>

    <p
      style="
        margin:0 0 4px;
        font-size:15px;
        color:#6B7280;
        line-height:1.6;
      "
    >
      A Super Admin at
      <strong style="color:#111827;">${BRAND}</strong>
      is verifying your email address before inviting you.
    </p>

    <p
      style="
        margin:0;
        font-size:14px;
        color:#6B7280;
      "
    >
      Please
      <strong>share this code with your Super Admin</strong>
      to confirm your email.
    </p>

    ${otpBlock(code, "5 minutes")}

    <table
      width="100%"
      cellpadding="0"
      cellspacing="0"
      border="0"
      style="
        background:#FFF7ED;
        border:1px solid #FED7AA;
        border-radius:10px;
        margin-top:8px;
      "
    >
      <tr>
        <td
          style="
            padding:14px 18px;
          "
        >
          <p
            style="
              margin:0;
              font-size:13px;
              color:#92400E;
              line-height:1.6;
            "
          >
            ⚠️ Read this code to your Super Admin over the phone
            or in person. Do not send it over chat unless you trust
            the channel.
          </p>
        </td>
      </tr>
    </table>
  `;

  try {
    const info = await transporter.sendMail({
      from: `"${BRAND}" <${process.env.EMAIL}>`,
      to,

      subject: "Your BiZONANCE CRM verification code",

      text:
        `Your Super Admin is inviting you to ${BRAND}. ` +
        `Share this code with them: ${code}. ` +
        `It expires in 5 minutes.`,

      html: buildEmail({
        title: "BiZONANCE CRM email verification",
        preheader:
          "Share this verification code with your Super Admin to confirm your email",
        body,
      }),

      attachments: logoAttachments,
    });

    console.log("Email sent:", {
      messageId: info.messageId,
      accepted: info.accepted,
      rejected: info.rejected,
      response: info.response,
    });
  } catch (err) {
    console.error("sendVerifyEmailOtp failed:", err);
    throw err;
  }
}


module.exports = {
  sendOtpEmail,
  sendInviteEmail,
  sendVerifyEmailOtp,
};
