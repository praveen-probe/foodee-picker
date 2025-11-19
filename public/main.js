(function () {
  const statusMessage = document.getElementById("statusMessage");
  const joinForm = document.getElementById("joinForm");
  const otpSection = document.getElementById("otpSection");
  const sendCodeBtn = document.getElementById("sendCodeBtn");
  const verifyOtpBtn = document.getElementById("verifyOtpBtn");
  const nameInput = document.getElementById("displayName");
  const phoneInput = document.getElementById("phoneNumber");
  const otpInput = document.getElementById("otpCode");

  if (!window.firebaseConfig) {
    statusMessage.textContent =
      "Missing Firebase config. Update public/firebase-config.js.";
    statusMessage.className = "message error";
    joinForm?.setAttribute("aria-disabled", "true");
    return;
  }

  firebase.initializeApp(window.firebaseConfig);
  firebase.auth().useDeviceLanguage();
  const auth = firebase.auth();
  const db = firebase.firestore();
  const functions = firebase.functions();

  let confirmationResult = null;

  const recaptchaVerifier = new firebase.auth.RecaptchaVerifier(
    "recaptcha-container",
    {
      size: "invisible",
      callback: () => {
        // Automatically triggered when reCAPTCHA is solved.
      },
    }
  );
  recaptchaVerifier.render().catch((error) => {
    console.error("reCAPTCHA render error", error);
    setStatus("Captcha failed to load. Reload the page.", "error");
  });

  const setStatus = (text, type = "info") => {
    statusMessage.textContent = text;
    let variant = "";
    if (type === "error") variant = "error";
    if (type === "success") variant = "success";
    statusMessage.className = variant ? `message ${variant}` : "message";
  };

  const toggleLoading = (element, isLoading, label) => {
    if (!element) return;
    element.disabled = isLoading;
    element.textContent = isLoading ? "Please wait..." : label;
  };

  const sanitizePhone = (phone) => {
    const trimmed = phone.replace(/\s+/g, "");
    if (!trimmed.startsWith("+")) {
      return `+${trimmed}`;
    }
    return trimmed;
  };

  const requestLocation = () =>
    new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error("This device does not support location services."));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (position) => {
          resolve({
            lat: position.coords.latitude,
            lng: position.coords.longitude,
          });
        },
        (error) => {
          reject(
            new Error(
              error.message ||
                "Location permission denied. Enable it to continue."
            )
          );
        },
        {
          enableHighAccuracy: true,
          timeout: 15000,
          maximumAge: 0,
        }
      );
    });

  joinForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus("", "info");
    const displayName = nameInput.value.trim();
    const phoneRaw = phoneInput.value.trim();

    if (!displayName || !phoneRaw) {
      setStatus("Please enter your name and phone number.", "error");
      return;
    }

    try {
      toggleLoading(sendCodeBtn, true, "Send join code");
      const phoneNumber = sanitizePhone(phoneRaw);
      confirmationResult = await auth.signInWithPhoneNumber(
        phoneNumber,
        recaptchaVerifier
      );
      otpSection.style.display = "flex";
      setStatus("Code sent! Check your phone.", "success");
      otpInput.focus();
    } catch (error) {
      console.error("send OTP failed", error);
      recaptchaVerifier.reset();
      setStatus(error.message || "Unable to send code. Try again.", "error");
    } finally {
      toggleLoading(sendCodeBtn, false, "Send join code");
    }
  });

  verifyOtpBtn.addEventListener("click", async () => {
    if (!confirmationResult) {
      setStatus("Request a code first.", "error");
      return;
    }

    const code = otpInput.value.trim();
    if (code.length < 6) {
      setStatus("Enter the 6-digit code.", "error");
      return;
    }

    try {
      toggleLoading(verifyOtpBtn, true, "Verify & join");
      const displayName = nameInput.value.trim();
      const phoneNumber = sanitizePhone(phoneInput.value.trim());

      const result = await confirmationResult.confirm(code);
      const { uid } = result.user;

      const ownerId = "demoOwner";

      const checkUserLimit = functions.httpsCallable("checkUserLimit");
      const limitCheck = await checkUserLimit({ ownerId });
      if (!limitCheck.data.allowed) {
        throw new Error(
          `Owner has reached the user limit (${limitCheck.data.current}/${limitCheck.data.limit}). Please contact the owner for premium access.`
        );
      }

      setStatus("Please allow location access to finish joining.");
      let location;
      try {
        location = await requestLocation();
      } catch (geoError) {
        throw new Error(
          geoError.message ||
            "Location permission is required to finish joining."
        );
      }

      await db
        .collection("owners")
        .doc(ownerId)
        .collection("users")
        .doc(uid)
        .set(
          {
            uid,
            name: displayName,
            phone: phoneNumber,
            joinedAt: firebase.firestore.FieldValue.serverTimestamp(),
            location: {
              lat: location.lat,
              lng: location.lng,
              timestamp: firebase.firestore.FieldValue.serverTimestamp(),
            },
          },
          { merge: true }
        );

      joinForm.reset();
      otpSection.style.display = "none";
      confirmationResult = null;
      setStatus("You're joined! Welcome to foodee picker.", "success");
    } catch (error) {
      console.error("verify OTP failed", error);
      setStatus(error.message || "Verification failed. Try again.", "error");
    } finally {
      toggleLoading(verifyOtpBtn, false, "Verify & join");
    }
  });
})();
