import { render } from "solid-js/web";
import { Route, Router } from "@solidjs/router";
import App from "./App.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("[yurume] root element not found");
}

render(
  () => (
    <Router>
      <Route path="/*" component={App} />
    </Router>
  ),
  root,
);
