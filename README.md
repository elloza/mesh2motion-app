<img src="./mesh2motion.svg" alt="Mesh2Motion Logo" width="400"/>

> [!NOTE]
> **This is a fork of [Mesh2Motion](https://github.com/Mesh2Motion/mesh2motion-app)** (the "Auto-Fit Rig" fork).
> All credit for Mesh2Motion goes to its creator **Scott Petrovic** and the
> [Mesh2Motion contributors](https://github.com/Mesh2Motion/mesh2motion-app/graphs/contributors).
> For the official app use https://app.mesh2motion.org/. This fork adds experimental features on top of it.
>
> **Try this fork live:** https://elloza.github.io/mesh2motion-app/create.html

### What this fork adds

- **Auto Fit Skeleton** (Create → Human → Position Joints). Fits the human rig to an A-pose or T-pose model in the browser. It shows a confidence score for each joint, lets you correct the result by hand and undo it in one step. It also corrects the animations' rest pose so the arms do not look contracted.
- **Faster binding for dense meshes**, such as 50K+ triangle AI-generated characters.
- **Optimize for games**: reduce triangles and texture size before rigging.
- **FBX export that works in game engines**:
  - Unreal preset: Y up, centimeters, the character faces +Y like the UE mannequin.
  - Unity preset: meters.
  - Choose the character height at export (1.80 m by default).
- **Engine pack ZIP**: the character plus a set of animations ready to import into Unreal or Unity.
- **Export progress indicator**, which replaces the post-download rating dialog.
- **GitHub Pages deployment** of this fork (`.github/workflows/deploy-pages.yml`).

The Unreal export has been tested in Unreal Engine 5.1. The Unity export has not been tested yet.

Everything below is the original Mesh2Motion README.

---

<table>
  <tr>
    <td><h4>Discord<h4></td>
    <td><a href="https://discord.gg/UChE936q7y">Join the Discord channel</a></td>
    <td>
      <img src="https://img.shields.io/discord/1408921718231273613?label=People&color=purple" alt="Discord">
    </td>
  </tr>
</table>

Import a 3D Model and automatically assign and export animations with Mesh2Motion. This is kind of similar to a web application like Mixamo, but I would like it to be more flexible so it can support other model and skeleton types. Hopefully the open source nature means it can be expanded on and evolve more than than the closed tools have. 

The marketing site that explains features and release notes: https://mesh2motion.org/

Try it live: https://app.mesh2motion.org/

![Screenshot](./readme.png)

## Usage
There are instructions built into the web application, but this is the general flow of how to use it:
1. Import a 3d model of your choosing (currently only supports GLB/GLTF format)
2. Pick what type of skeleton that the 3d model will use
3. Modify the skeleton to fit inside of the model (optionally test the results)
4. Test out various animations to see the results.
5. Select which animations you want to use, then export (currently only GLB/GLTF supported format)

## Building and running locally
The main dependency you need is Node.js. I am using 24, but other versions probably work fine too. Open you command line tool to the directory this readme is in. Run ths following commands to start the web server.

    npm install
    npm run dev

## Creating a production build for the web
We mostly just have typescript for this project, which web browsers cannot just read, so we need to do a build step to get everything ready for deploying. This project uses Vite for the web server and builder. See the vite.config.js for more info. This command will create a "dist" folder with all the files to serve to the web:

    npm run build

## Running in Docker
If you don't want to modify your local file system, you can alternitvely build and run the project from Docker. Make sure you have Docker and Docker Compose installed. Navigate your command line tool to this directory where your Dockerfile is at. Make sure Docker is actually started and running before you run this command.

Execute the following command.

    docker-compose up -d

To try it out, visit http://localhost:3000

## Running and creating video previews
There is separate tool in the web app where you can generate video previews for each animation. It isn't too hard to run, but it has a separate README file that explains how that works. It is more of an internal tool, so I didn't want to muddy up this page too much.

[Preview Generator Documentation](src/preview-generator/README.md)

## Blender 3D Source files
Many of the 3d files are originally created using Blender. This includes 3d models, rigs, and animations. To prevent this repository from becoming too large with big animation files, these source files are separated into a different repository. The final compressed GLB files are saved to this repository. These source files aren't needed to buil and run the application, so you can ignore this unless you want to contribute more animations. This repository is located here: https://github.com/Mesh2Motion/mesh2motion-assets

## Licenses

The code and platform are all licensed under the very permissive MIT license. The art assets (3d models, rigs, animations) are all licensed under CC0. I tried making everything as open as possible to remix, change, and build upon for the future.


## ❤️ Help the Project Grow
I don't expect to be receiving money for working on this, but I am also not the best animator. If people want to see better, and more, animations made, add to the fund. I can pay for an animator to help build out the animation library better. Or, if you know an animator that wants to help with this, send them my way! I am just a dude working on this during nights and weekends.

Tip page to help out: https://support.mesh2motion.org/











