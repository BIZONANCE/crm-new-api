const axios = require("axios");
const FormData = require("form-data");

const MEDIA_UPLOAD = process.env.MEDIA_UPLOAD;
const MEDIA_DOWNLOAD = process.env.MEDIA_DOWNLOAD;

// Uploads a single image buffer to the Bizonance media server and returns
// the full public download URL to store on the user's photoUrl field.
async function uploadImage(fileBuffer, filename, mimetype) {
  const form = new FormData();

  // The media server expects the multipart field name "file".
  form.append("file", fileBuffer, {
    filename,
    contentType: mimetype,
  });

  const { data } = await axios.post(MEDIA_UPLOAD, form, {
    headers: form.getHeaders(),
  });

  // Media server returns:
  // {
  //   message: "Images uploaded successfully",
  //   uploadedImages: [
  //     { filename: "1788285059868-example.png" }
  //   ]
  // }
  const filenameOrId =
    data.uploadedImages?.[0]?.filename ||
    data.filename ||
    data.data?.filename ||
    data.name ||
    data.id;

  if (!filenameOrId) {
    console.error("Unexpected media server response:", data);
    throw new Error("Media server did not return a filename/id");
  }

  return `${MEDIA_DOWNLOAD}/${filenameOrId}`;
}

module.exports = { uploadImage };
