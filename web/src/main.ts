import { createApp } from "vue";
import App from "./App.vue";
import { installDemoNetwork, isDemo } from "./demo";
import "@tabler/icons-webfont/dist/tabler-icons.css";
import "./style.css";

if (isDemo) installDemoNetwork();
createApp(App).mount("#app");
