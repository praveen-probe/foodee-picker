(function () {
  const TARGET_COORDINATES = { lat: 13.0674, lng: 80.2376 };
  const INSIDE_RADIUS_METERS = 300;

  const loginForm = document.getElementById("loginForm");
  const loginStatus = document.getElementById("loginStatus");
  const loginButton = document.getElementById("loginButton");
  const ownerIdInput = document.getElementById("ownerId");
  const emailInput = document.getElementById("ownerEmail");
  const passwordInput = document.getElementById("ownerPassword");

  const dashboard = document.getElementById("dashboard");
  const subscriptionPlanEl = document.getElementById("subscriptionPlan");
  const activeCountEl = document.getElementById("activeCount");
  const regularCountEl = document.getElementById("regularCount");
  const userListEl = document.getElementById("userList");
  const regularListEl = document.getElementById("regularList");
  const refreshButton = document.getElementById("refreshGuests");

  const messageForm = document.getElementById("messageForm");
  const messageInput = document.getElementById("messageInput");
  const messageStatus = document.getElementById("messageStatus");
  const sendMessageBtn = document.getElementById("sendMessageBtn");

  if (!window.firebaseConfig) {
    loginStatus.textContent =
      "Missing Firebase config. Update public/firebase-config.js.";
    loginButton.disabled = true;
    return;
  }

  const app =
    firebase.apps && firebase.apps.length
      ? firebase.app()
      : firebase.initializeApp(window.firebaseConfig);
  const auth = firebase.auth(app);
  const db = firebase.firestore(app);
  const functions = firebase.functions(app);

  let activeUsers = [];
  let regularUsers = [];
  let unsubscribeActive = null;
  let unsubscribeRegular = null;
  let currentOwnerId = ownerIdInput.value.trim();

  const toRadians = (deg) => (deg * Math.PI) / 180;
  const distanceBetweenMeters = (a, b) => {
    if (!a || !b) return Infinity;
    const dLat = toRadians(b.lat - a.lat);
    const dLng = toRadians(b.lng - a.lng);
    const lat1 = toRadians(a.lat);
    const lat2 = toRadians(b.lat);
    const haversine =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(haversine));
  };

  const computeLocationStatus = (location) => {
    if (
      !location ||
      typeof location.lat !== "number" ||
      typeof location.lng !== "number"
    ) {
      return { inside: false, label: "No location yet", distance: null };
    }
    const distance = distanceBetweenMeters(location, TARGET_COORDINATES);
    const inside = distance <= INSIDE_RADIUS_METERS;
    return {
      inside,
      label: inside
        ? "Inside the welcome zone"
        : `Outside (${distance.toFixed(0)} m)`,
      distance,
    };
  };

  const setLoginStatus = (text, tone = "info") => {
    loginStatus.textContent = text;
    loginStatus.style.color =
      tone === "error" ? "var(--danger)" : "var(--muted)";
  };

  const toggleDashboard = (show) => {
    dashboard.style.display = show ? "flex" : "none";
    if (!show) {
      activeUsers = [];
      regularUsers = [];
      updateLists();
    }
  };

  const createUserCard = (user, options = {}) => {
    const card = document.createElement("div");
    card.className = "list-item";

    const meta = document.createElement("div");
    meta.className = "user-meta";

    const title = document.createElement("strong");
    title.textContent = user.name || "Unnamed guest";
    meta.appendChild(title);

    const phone = document.createElement("small");
    phone.textContent = user.phone || "No phone";
    meta.appendChild(phone);

    const status = document.createElement("small");
    const locStatus = computeLocationStatus(user.location);
    status.textContent = locStatus.label;
    meta.appendChild(status);

    card.appendChild(meta);

    const badge = document.createElement("span");
    badge.className = "badge";
    if (options.regular) {
      badge.classList.add("regular");
      badge.textContent = "Regular";
    } else if (locStatus.inside) {
      badge.classList.add("in");
      badge.textContent = "Inside radius";
    } else {
      badge.classList.add("out");
      badge.textContent = "Outside";
    }

    card.appendChild(badge);
    return card;
  };

  const renderList = (element, items, options) => {
    element.innerHTML = "";
    if (!items.length) {
      const empty = document.createElement("p");
      empty.textContent = options?.emptyLabel || "No users yet.";
      empty.style.color = "var(--muted)";
      element.appendChild(empty);
      return;
    }
    items.forEach((user) => {
      element.appendChild(createUserCard(user, options));
    });
  };

  const updateLists = () => {
    activeCountEl.textContent = activeUsers.length.toString();
    regularCountEl.textContent = regularUsers.length.toString();

    const planText = subscriptionPlanEl.textContent.toLowerCase();
    const isFree = planText === "free";
    const userCount = activeUsers.length;
    const limit = 100;

    if (isFree && userCount >= limit) {
      activeCountEl.textContent = `${userCount} / ${limit} (LIMIT)`;
      activeCountEl.style.color = "var(--danger)";
    } else {
      activeCountEl.style.color = "";
    }

    renderList(userListEl, activeUsers, {
      emptyLabel: "No active guests yet.",
    });
    renderList(regularListEl, regularUsers, {
      regular: true,
      emptyLabel: "No regular guests yet.",
    });
  };

  const subscribeToOwner = (ownerId) => {
    currentOwnerId = ownerId;

    if (unsubscribeActive) unsubscribeActive();
    if (unsubscribeRegular) unsubscribeRegular();

    activeUsers = [];
    regularUsers = [];
    updateLists();

    const ownerRef = db.collection("owners").doc(ownerId);

    ownerRef.onSnapshot(
      (snapshot) => {
        const data = snapshot.data();
        const plan = (data?.subscriptionPlan || "free").toUpperCase();
        subscriptionPlanEl.textContent = plan;
        const isPremium = plan === "PREMIUM";
        sendMessageBtn.disabled = !isPremium;
        if (!isPremium) {
          messageInput.placeholder =
            "Upgrade to premium to send messages to users.";
        } else {
          messageInput.placeholder =
            "What would you like to share with everyone?";
        }
      },
      (error) => {
        console.error("Owner subscription error", error);
      }
    );

    unsubscribeActive = ownerRef.collection("users").onSnapshot(
      (snapshot) => {
        activeUsers = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        }));
        updateLists();
      },
      (error) => {
        console.error("Active users listener error", error);
        setLoginStatus(error.message || "Unable to load users.", "error");
      }
    );

    unsubscribeRegular = ownerRef
      .collection("regularUsers")
      .onSnapshot(
        (snapshot) => {
          regularUsers = snapshot.docs.map((doc) => ({
            id: doc.id,
            ...doc.data(),
          }));
          updateLists();
        },
        (error) => {
          console.error("Regular users listener error", error);
          setLoginStatus(error.message || "Unable to load regulars.", "error");
        }
      );
  };

  auth.onAuthStateChanged((user) => {
    if (user) {
      setLoginStatus(`Signed in as ${user.email}`, "info");
      toggleDashboard(true);
      subscribeToOwner(ownerIdInput.value.trim());
    } else {
      setLoginStatus("Sign in to manage guests.");
      toggleDashboard(false);
      if (unsubscribeActive) unsubscribeActive();
      if (unsubscribeRegular) unsubscribeRegular();
      unsubscribeActive = null;
      unsubscribeRegular = null;
    }
  });

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const ownerId = ownerIdInput.value.trim();
    const email = emailInput.value.trim();
    const password = passwordInput.value;

    if (!ownerId || !email || !password) {
      setLoginStatus("Fill in all fields.", "error");
      return;
    }

    try {
      loginButton.disabled = true;
      loginButton.textContent = "Signing in...";
      await auth.signInWithEmailAndPassword(email, password);
      setLoginStatus("Signed in successfully!");
      subscribeToOwner(ownerId);
    } catch (error) {
      console.error("Owner login failed", error);
      setLoginStatus(error.message || "Unable to sign in.", "error");
    } finally {
      loginButton.disabled = false;
      loginButton.textContent = "Sign in";
    }
  });

  refreshButton.addEventListener("click", () => {
    if (!auth.currentUser) {
      setLoginStatus("Sign in first to refresh data.", "error");
      return;
    }
    subscribeToOwner(ownerIdInput.value.trim());
  });

  messageForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!auth.currentUser) {
      messageStatus.textContent = "Sign in before sending messages.";
      return;
    }

    const ownerId = ownerIdInput.value.trim();
    const message = messageInput.value.trim();

    if (!message) {
      messageStatus.textContent = "Enter a message first.";
      return;
    }

    try {
      sendMessageBtn.disabled = true;
      sendMessageBtn.textContent = "Sending...";
      messageStatus.textContent = "";
      const sendManualMessage = functions.httpsCallable("sendManualMessage");
      await sendManualMessage({ ownerId, message, includeRegularUsers: true });
      messageStatus.textContent = "Message sent to all devices!";
      messageInput.value = "";
    } catch (error) {
      console.error("Send message failed", error);
      messageStatus.textContent =
        error.message || "Could not send the notification.";
    } finally {
      sendMessageBtn.disabled = false;
      sendMessageBtn.textContent = "Send push notification";
    }
  });
})();
