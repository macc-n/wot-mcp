# WoT-MCP

WoT-MCP is a server application that exposes Web of Things (WoT) devices to AI assistants via the Model Context Protocol (MCP).

As AI agents become more sophisticated, their ability to interact with the real world remains limited by fragmented IoT protocols. WoT-MCP solves this by translating the standardized **Web of Things** model (Properties, Actions, Events) into **MCP** primitives (Resources and Tools).

This allows any MCP-compliant AI client (like Claude Desktop or LangChain agents) to natively discover, monitor, and control physical devices without needing custom code for each device.

## Features

- **Protocol Translation**: Converts WoT Properties, Actions, and Events into MCP Resources and Tools.
- **Two Tool Strategies**:
    - `explicit`: Generates individual tools for every property and action (e.g., `set_temperature`, `get_humidity`). Best for small numbers of devices.
    - `generic`: Provides a fixed set of tools (`list_devices`, `read_property`, `write_property`, `invoke_action`) to manage any number of devices. Best for scalability.
- **Transport Modes**: Supports both `stdio` and `streamable-http`.
- **Event Buffering**: Captures WoT events and exposes them as MCP resources.
- **Docker Support**: Ready-to-use Dockerfile for containerized deployment.

## Installation

```bash
git clone https://github.com/macc-n/wot-mcp.git
cd wot-mcp
npm install
npm run build
```

## Usage

### Stdio (Local Clients)

To use WoT-MCP with local clients like **Claude Desktop**, you can configure them to spawn the server directly.

**Claude Desktop Configuration:**
Add the following to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "wot": {
      "command": "npm",
      "args": [
        "--prefix",
        "<absolute-path>/wot-mcp",
        "start",
        "--",
        "--tool-strategy",
        "explicit",
        "--config",
        "<absolute-path>/things-config.json"
      ]
    }
  }
}
```

> **Note:** Ensure you use absolute paths for both the script and the configuration file.

### Streamable HTTP

To expose the MCP server over HTTP:

```bash
npm start -- --mode streamable-http --port 3000 --config things-config.json
```

**Claude Desktop Configuration:**
Add the following to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "wot": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://<remote-ip>:<port>/mcp",
        "--allow-http"
      ]
    }
  }
}
```

### Tool Strategies

**Explicit Strategy (Default)**
Creates a unique tool for every capability:
* WoT Property:
    * Creates a **getter** tool.
    * If the property is writable, creates also a **setter** tool.
* WoT Action:
    * Create a single tool with the input schema derived directly from the WoT Action input schema.
*WoT Event:
    * Exposes a subscriptable resource.
```bash
npm start -- --tool-strategy explicit --config things-config.json
```

**Generic Strategy**
Uses 4 static tools to manage all devices:
* `list_devices`: Return a JSON list of all devices and their capabilties.
* `read_property`: Takes `devide_id` and `property_name`.
* `write_property`: Takes `devide_id`, `property_name`, and `value`.
* `invoke_action`: Takes `devide_id`, `action_name`, and optional `params`.
> **Note:** WoT Events are managed as described before.
```bash
npm start -- --tool-strategy generic --config things-config.json
```

### Configuration File

You must load things from a JSON configuration file. The file supports HTTP, CoAP, and MQTT devices.

```json
// things-config.json
{
  "things": [
    {
        "protocol": "http",
        "url": "http://localhost:8080/httpthermostat"
    },
    {
        "protocol": "coap",
        "url": "coap://localhost:5683/coaplight"
    },
    {
        "protocol": "mqtt",
        "url": "mqtt://test.mosquitto.org/MqttSensor",
        "td": "/path/to/mqtt-td.json"
    }
  ]
}
```

**Note:** For `mqtt` devices, the `td` field is required and must point to a local file containing the Thing Description, as TD discovery is not supported over MQTT.

## Examples

The [wot-mcp-cli](https://github.com/macc-n/wot-mcp-cli) repository contains an interactive Command Line Interface (CLI) client for the WoT-MCP server, allowing you to inspect tools and interact with devices.

The [wot-mcp-examples](https://github.com/macc-n/wot-mcp-examples) repository contains sample code for devices, configuration files, and clients.

For comprehensive documentation and further details, please consult the respective repositories.


## Docker

Build the image:
```bash
docker build -t wot-mcp .
```

Run with a configuration file:
```bash
docker run --rm --network="host" \
  -v $(pwd)/things-config.json:/app/things-config.json \
  wot-mcp \
  --tool-strategy explicit \
  --config /app/things-config.json \
  --mode streamable-http \
  --port 3000
```
> **Note:** Replace the path of the config file.

## Known Limitations

This first release focuses on the core functionality of bridging Web of Things devices to MCP. It does not yet include advanced features such as authentication, security mechanisms, or a persistent storage layer.